#!/usr/bin/env node
/**
 * Operational v1 verification. The adapter executes the Worker SQL against
 * node:sqlite so owner revoke, private result cleanup, and cron maintenance are
 * observable without a remote Cloudflare account.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import api from "../../workers/api/src/index.js";
import { issueSession } from "../../workers/api/src/auth.js";
import { POLICY, utcDay } from "../../workers/api/src/policy.js";
import { cleanupOrphanResults, enqueue, revokeJob } from "../../workers/api/src/queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, "../../workers/api/migrations/0001_init.sql");
const migration = readFileSync(migrationPath, "utf8");
const indexSource = readFileSync(resolve(here, "../../workers/api/src/index.js"), "utf8");
const migrationSource = migration;
assert.doesNotMatch(indexSource, /\b(?:ADMIN_TOKEN|RESEND_API_KEY|promotable|emailStatus|github)\b/iu);
assert.doesNotMatch(migrationSource, /\b(?:lane|priority|email|admin)\b/iu);

class SqliteStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    return this.db.raw.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.db.raw.prepare(this.sql).all(...this.args) };
  }

  async run() {
    const result = this.db.raw.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes ?? 0) }, changes: Number(result.changes ?? 0) };
  }
}

class SqliteD1 {
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec(migration);
  }

  prepare(sql) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const result = this.raw.prepare(statement.sql).run(...statement.args);
        results.push({ meta: { changes: Number(result.changes ?? 0) }, changes: Number(result.changes ?? 0) });
      }
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  get(sql, ...args) {
    return this.raw.prepare(sql).get(...args) ?? null;
  }
}

function makeR2() {
  const objects = new Map();
  const uploadedAt = new Map();
  const deleted = [];
  let failDeletes = false;
  return {
    objects,
    deleted,
    setObject(key, value, uploaded = new Date(0)) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      uploadedAt.set(key, uploaded);
    },
    async put(key, value) {
      this.setObject(key, value, new Date());
    },
    async get(key) {
      const body = objects.get(key);
      return body ? { body, size: body.byteLength } : null;
    },
    setFailDelete(value) {
      failDeletes = Boolean(value);
    },
    async delete(key) {
      if (failDeletes) throw new Error("r2 delete unavailable");
      deleted.push(key);
      objects.delete(key);
      uploadedAt.delete(key);
    },
    async list({ prefix } = {}) {
      return {
        truncated: false,
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .map((key) => ({ key, uploaded: uploadedAt.get(key) ?? new Date(0) })),
      };
    },
  };
}

function makeEnv(db, r2, overrides = {}) {
  return {
    DB: db,
    RESULTS: r2,
    ENVIRONMENT: "development",
    SITE_ORIGIN: "http://127.0.0.1:5180",
    API_ORIGIN: "http://127.0.0.1:8787",
    SESSION_SIGNING_KEY: "ops-test-session-key",
    ...overrides,
  };
}

function account(db, id) {
  db.raw.prepare("INSERT OR IGNORE INTO accounts(id, created_at) VALUES (?, ?)").run(id, 0);
}

function job(db, values) {
  const now = values.now ?? Date.now();
  const accountId = values.accountId ?? values.id;
  account(db, accountId);
  db.raw.prepare(
    `INSERT INTO jobs(
       id, token, account_id, status, prompt, prompt_hash, attempts,
       lease_owner, lease_token, lease_expires_at, result_key, error,
       usage_day, created_at, started_at, finished_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.token ?? values.id,
    accountId,
    values.status ?? "queued",
    values.prompt ?? "ops prompt",
    values.promptHash ?? `${values.id}-hash`,
    values.attempts ?? 0,
    values.leaseOwner ?? null,
    values.leaseToken ?? null,
    values.leaseExpiresAt ?? null,
    values.resultKey ?? null,
    values.error ?? null,
    values.usageDay ?? utcDay(now),
    values.createdAt ?? now,
    values.startedAt ?? null,
    values.finishedAt ?? null,
    values.expiresAt ?? now + 86_400_000,
  );
}

async function requestWithSession(env, accountId, url, init = {}) {
  const session = await issueSession(accountId, env);
  const headers = new Headers(init.headers);
  headers.set("origin", env.SITE_ORIGIN);
  headers.set("cookie", `__Host-cc_sess=${session}`);
  return api.fetch(new Request(url, { ...init, headers }), env, {});
}

// Owner revoke is the only user mutation retained by the hosted demo. It
// refunds queued/running admissions, clears leases, and releases the active
// account slot; a completed artifact is removed from private R2 as well.
{
  const db = new SqliteD1();
  const r2 = makeR2();
  const env = makeEnv(db, r2);
  const now = Date.now();
  account(db, "owner");
  db.raw.prepare("INSERT INTO daily_usage(account_id, day, used, reserved_job_id) VALUES (?, ?, ?, ?)").run(
    "owner",
    utcDay(now),
    1,
    "queued-revoke",
  );
  job(db, { id: "queued-revoke", token: "queued-revoke-token", accountId: "owner", status: "queued", now });

  const revokeResponse = await requestWithSession(env, "owner", "http://127.0.0.1:8787/jobs/queued-revoke-token/revoke", { method: "POST" });
  assert.equal(revokeResponse.status, 200);
  assert.equal(db.get("SELECT status FROM jobs WHERE id='queued-revoke'").status, "revoked");
  assert.equal(db.get("SELECT lease_token FROM jobs WHERE id='queued-revoke'").lease_token, null);
  assert.equal(db.get("SELECT used FROM daily_usage WHERE account_id='owner' AND day=?", utcDay(now)).used, 0);
  const replacement = await enqueue({ DB: db }, { accountId: "owner", prompt: "replacement", promptHash: "replacement-hash", now });
  assert.equal(replacement.ok, true, "revoked status releases the active slot");

  const noSession = await api.fetch(new Request("http://127.0.0.1:8787/jobs/queued-revoke-token/revoke", {
    method: "POST",
    headers: { origin: env.SITE_ORIGIN },
  }), env, {});
  assert.equal(noSession.status, 401);
  account(db, "other-owner");
  job(db, { id: "other-job", token: "other-token", accountId: "other-owner", status: "queued", now });
  const wrongOwner = await requestWithSession(env, "owner", "http://127.0.0.1:8787/jobs/other-token/revoke", { method: "POST" });
  assert.equal(wrongOwner.status, 404);

  r2.setObject("results/done-revoke.npz", new Uint8Array([1, 2, 3]));
  job(db, {
    id: "done-revoke",
    token: "done-revoke-token",
    accountId: "owner",
    status: "done",
    resultKey: "results/done-revoke.npz",
    expiresAt: now + 86_400_000,
    finishedAt: now,
  });
  const doneRevoke = await requestWithSession(env, "owner", "http://127.0.0.1:8787/jobs/done-revoke-token/revoke", { method: "POST" });
  assert.equal(doneRevoke.status, 200);
  assert.equal(db.get("SELECT used FROM daily_usage WHERE account_id='owner' AND day=?", utcDay(now)).used, 1, "completed admissions are not refunded");
  assert.deepEqual(r2.deleted, ["results/done-revoke.npz"]);
  const revokedTicket = await api.fetch(new Request("http://127.0.0.1:8787/jobs/done-revoke-token"), env, {});
  const revokedResult = await api.fetch(new Request("http://127.0.0.1:8787/r/done-revoke-token.npz"), env, {});
  assert.equal(revokedTicket.status, 410);
  assert.equal(revokedResult.status, 410);
  assert.equal(revokedResult.headers.get("access-control-allow-origin"), env.SITE_ORIGIN);
  assert.equal(revokedResult.headers.get("access-control-allow-credentials"), null);
  assert.equal(revokedResult.headers.get("vary"), "Origin");

  // A failed immediate delete leaves a bounded orphan for the cron prefix sweep.
  r2.setObject("results/revoke-orphan.npz", new Uint8Array([4]));
  job(db, {
    id: "revoke-orphan",
    token: "revoke-orphan-token",
    accountId: "owner",
    status: "done",
    resultKey: "results/revoke-orphan.npz",
    expiresAt: now + 86_400_000,
    finishedAt: now,
  });
  r2.setFailDelete(true);
  const orphanRevoke = await requestWithSession(env, "owner", "http://127.0.0.1:8787/jobs/revoke-orphan-token/revoke", { method: "POST" });
  assert.equal(orphanRevoke.status, 200);
  assert.ok(r2.objects.has("results/revoke-orphan.npz"));
  r2.setFailDelete(false);
  await cleanupOrphanResults(env, now + POLICY.RESULT_ORPHAN_GRACE_MS + 1);
  assert.ok(r2.deleted.includes("results/revoke-orphan.npz"));
}

// Cron recovers expired leases, removes retained artifacts and old nonce/OAuth
// state, while keeping the expired D1 row so the API can answer 410.
{
  const db = new SqliteD1();
  const r2 = makeR2();
  const env = makeEnv(db, r2);
  const now = Date.now();
  job(db, {
    id: "lease-expired",
    accountId: "cron-account",
    status: "running",
    attempts: 1,
    leaseToken: "expired-lease",
    leaseOwner: "box",
    leaseExpiresAt: now - 1,
    startedAt: now - 10_000,
    now,
  });
  r2.setObject("results/expired.npz", new Uint8Array([9]), new Date(now - 86_400_000));
  r2.setObject("results/orphan.npz", new Uint8Array([8]), new Date(0));
  r2.setObject("results/fresh-orphan.npz", new Uint8Array([7]), new Date(now));
  r2.setObject("results/referenced.npz", new Uint8Array([6]), new Date(0));
  job(db, {
    id: "retention-expired",
    token: "retention-expired-token",
    accountId: "cron-account",
    status: "done",
    resultKey: "results/expired.npz",
    expiresAt: now - 1,
    finishedAt: now - 86_400_000,
    now,
  });
  job(db, {
    id: "retention-live",
    token: "retention-live-token",
    accountId: "cron-account",
    status: "done",
    resultKey: "results/referenced.npz",
    expiresAt: now + 86_400_000,
    finishedAt: now,
    now,
  });
  db.raw.prepare("INSERT INTO worker_nonce(nonce, seen_at) VALUES (?, ?), (?, ?)").run(
    "old-nonce",
    now - POLICY.WORKER_NONCE_TTL_MS - 1,
    "fresh-nonce",
    now,
  );
  db.raw.prepare("INSERT INTO oauth_state(state_hash, provider, next_path, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)").run(
    "old-state",
    "google",
    "/demo/",
    now - POLICY.OAUTH_STATE_TTL_MS - 1,
    "fresh-state",
    "google",
    "/demo/",
    now,
  );

  await api.scheduled({}, env, {});
  assert.equal(db.get("SELECT status FROM jobs WHERE id='lease-expired'").status, "queued");
  assert.ok(r2.deleted.includes("results/expired.npz"));
  assert.ok(r2.deleted.includes("results/orphan.npz"));
  assert.ok(r2.objects.has("results/fresh-orphan.npz"));
  assert.ok(r2.objects.has("results/referenced.npz"));
  assert.equal(db.get("SELECT result_key FROM jobs WHERE id='retention-expired'").result_key, null);
  assert.equal(db.get("SELECT nonce FROM worker_nonce WHERE nonce='old-nonce'"), null);
  assert.ok(db.get("SELECT nonce FROM worker_nonce WHERE nonce='fresh-nonce'"));
  assert.equal(db.get("SELECT state_hash FROM oauth_state WHERE state_hash='old-state'"), null);
  assert.ok(db.get("SELECT state_hash FROM oauth_state WHERE state_hash='fresh-state'"));
  const expiredTicket = await api.fetch(new Request("http://127.0.0.1:8787/jobs/retention-expired-token"), env, {});
  assert.equal(expiredTicket.status, 410);
}

// Removed surfaces stay absent: no admin dashboard/routes, no GitHub OAuth,
// and no legacy response metadata. These are deliberate negative checks.
{
  const db = new SqliteD1();
  const env = makeEnv(db, makeR2());
  const routePaths = [
    "/admin",
    "/admin/kill-switch",
    "/admin/cancel",
    "/admin/revoke",
    "/auth/github/start",
    "/auth/github/callback",
  ];
  for (const routePath of routePaths) {
    const response = await api.fetch(new Request(`http://127.0.0.1:8787${routePath}`), env, {});
    assert.equal(response.status, 404, `${routePath} must remain removed`);
  }

  // Regression: /auth/google/start must issue the provider redirect, never
  // fall through to the callback handler (match-group off-by-one shipped a 400).
  const start = await api.fetch(new Request("http://127.0.0.1:8787/auth/google/start?next=/demo/"), env, {});
  assert.equal(start.status, 302, "/auth/google/start redirects to Google");
  const startLocation = new URL(start.headers.get("location"));
  assert.equal(startLocation.hostname, "accounts.google.com");
  assert.ok(start.headers.get("set-cookie")?.includes("__Host-cc_oauth="), "start sets the state cookie");

  job(db, { id: "shape-job", token: "shape-token", accountId: "shape-account", status: "queued" });
  const ticket = await api.fetch(new Request("http://127.0.0.1:8787/jobs/shape-token"), env, {});
  assert.equal(ticket.status, 200);
  const payload = await ticket.json();
  for (const removedField of ["promotable", "emailStatus", "email"]) {
    assert.equal(Object.hasOwn(payload, removedField), false, `${removedField} is removed from GET /jobs/:token`);
  }
  assert.deepEqual(Object.keys(payload).sort(), [
    "createdAt",
    "etaMinutes",
    "etaText",
    "position",
    "promptText",
    "resultUrl",
    "status",
  ]);
}

console.log("PASS verify-ops (owner revoke, private R2, cron cleanup, removed-surface negatives)");
