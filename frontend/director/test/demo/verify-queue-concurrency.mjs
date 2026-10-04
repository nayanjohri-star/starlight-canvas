#!/usr/bin/env node
/**
 * Queue admission and claim concurrency verification against node:sqlite. The
 * adapter executes the same SQL strings used by the Worker, including the
 * transactional admission batch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dailyCapFor, POLICY, utcDay } from "../../workers/api/src/policy.js";
import { claimNext, positionOf } from "../../workers/api/src/queue.js";
import api from "../../workers/api/src/index.js";
import { issueSession } from "../../workers/api/src/auth.js";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, "../../workers/api/migrations/0001_init.sql"), "utf8");
const queueSource = readFileSync(resolve(here, "../../workers/api/src/queue.js"), "utf8");
const policySource = readFileSync(resolve(here, "../../workers/api/src/policy.js"), "utf8");
assert.doesNotMatch(queueSource, /\blane\b|\bpriority\b|\bdrain(?:ed|ing)?\b/iu);
assert.doesNotMatch(policySource, /\blaneFor\b|\bLANE_PHASES\b|\bpriority\b/iu);
assert.equal(POLICY.DAILY_CAP, 2);
assert.equal(dailyCapFor(), 2);
assert.equal("LANE_PHASES" in POLICY, false);

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

  exec(sql, ...args) {
    if (args.length) this.raw.prepare(sql).run(...args);
    else this.raw.exec(sql);
  }

  scalar(sql, ...args) {
    return this.raw.prepare(sql).get(...args) ?? null;
  }
}

function insertAccount(db, id) {
  db.raw.prepare("INSERT OR IGNORE INTO accounts(id, created_at) VALUES (?, ?)").run(id, 0);
}

function insertJob(db, {
  id,
  account = id,
  created = 0,
  prompt = "prompt",
  status = "queued",
  attempts = 0,
  expiresAt = Date.now() + 86_400_000,
}) {
  insertAccount(db, account);
  db.raw.prepare(
    `INSERT INTO jobs(
       id, token, account_id, status, prompt, prompt_hash, attempts,
       usage_day, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, account, status, prompt, `${id}-hash`, attempts, "2026-01-01", created, expiresAt);
}

function envFor(db) {
  return {
    DB: db,
    ENVIRONMENT: "development",
    SITE_ORIGIN: "http://127.0.0.1:5180",
    API_ORIGIN: "http://127.0.0.1:8787",
    SESSION_SIGNING_KEY: "queue-test-session-key",
    TURNSTILE_SECRET_KEY: "queue-test-turnstile-key",
  };
}

async function postBatch(db, accountId, prompts) {
  insertAccount(db, accountId);
  const env = envFor(db);
  const session = await issueSession(accountId, env);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  try {
    return await Promise.all(prompts.map((prompt) => api.fetch(new Request("http://127.0.0.1:8787/jobs", {
      method: "POST",
      headers: {
        origin: env.SITE_ORIGIN,
        "content-type": "application/json",
        cookie: `__Host-cc_sess=${session}`,
      },
      body: JSON.stringify({ prompt, turnstileToken: "queue-test-token" }),
    }), env, {})));
  } finally {
    globalThis.fetch = savedFetch;
  }
}

async function postEntries(db, entries) {
  const env = envFor(db);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  try {
    return await Promise.all(entries.map(async ({ accountId, prompt }) => {
      insertAccount(db, accountId);
      const session = await issueSession(accountId, env);
      return api.fetch(new Request("http://127.0.0.1:8787/jobs", {
        method: "POST",
        headers: {
          origin: env.SITE_ORIGIN,
          "content-type": "application/json",
          cookie: `__Host-cc_sess=${session}`,
        },
        body: JSON.stringify({ prompt, turnstileToken: "queue-test-token" }),
      }), env, {});
    }));
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// (a) Concurrent claims each win a distinct compare-and-set lease.
{
  const db = new SqliteD1();
  for (let index = 0; index < 8; index += 1) {
    insertJob(db, { id: `claim-${index}`, account: `claim-account-${index}`, created: index });
  }
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => claimNext({ DB: db }, `worker-${index}`)));
  const ids = claims.filter(Boolean).map((claim) => claim.jobId);
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE status='running'").count, 8);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'").count, 0);
}

// (b) Claims are one FIFO stream, including same-timestamp id tie-breaks.
{
  const db = new SqliteD1();
  insertJob(db, { id: "fifo-b", account: "fifo-b-account", created: 1 });
  insertJob(db, { id: "fifo-a", account: "fifo-a-account", created: 1 });
  insertJob(db, { id: "fifo-c", account: "fifo-c-account", created: 2 });
  const order = [];
  for (let index = 0; index < 3; index += 1) order.push((await claimNext({ DB: db }, "fifo-worker")).jobId);
  assert.deepEqual(order, ["fifo-a", "fifo-b", "fifo-c"]);
}

// (c) Position uses the same created_at,id total order as claim.
{
  const db = new SqliteD1();
  insertJob(db, { id: "pos-b", account: "pos-b-account", created: 1 });
  insertJob(db, { id: "pos-a", account: "pos-a-account", created: 1 });
  insertJob(db, { id: "pos-c", account: "pos-c-account", created: 2 });
  const row = await db.prepare("SELECT * FROM jobs WHERE id='pos-c'").first();
  assert.equal(await positionOf(db, row), 3);
}

// (d) The partial unique index still allows only one active job per account.
{
  const db = new SqliteD1();
  const responses = await postBatch(db, "same-account", Array.from({ length: 8 }, (_, index) => `prompt-${index}`));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE account_id='same-account'").count, 1);
  assert.equal(db.scalar("SELECT used FROM daily_usage WHERE account_id='same-account'").used, 1);
}

// (e) The account-wide daily cap is exactly two admissions, independent of any
// removed lane or priority classification.
{
  const db = new SqliteD1();
  insertAccount(db, "capped-account");
  const day = utcDay();
  db.raw.prepare("INSERT INTO daily_usage(account_id, day, used, reserved_job_id) VALUES (?, ?, ?, ?)").run(
    "capped-account",
    day,
    dailyCapFor(),
    "old-marker",
  );
  const responses = await postBatch(db, "capped-account", Array.from({ length: 8 }, (_, index) => `cap-${index}`));
  assert.equal(responses.every((response) => response.status === 429), true);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE account_id='capped-account'").count, 0);
  assert.equal(db.scalar("SELECT used FROM daily_usage WHERE account_id='capped-account'").used, 2);
  const sequential = await postBatch(db, "capped-account", ["after"]);
  assert.equal(sequential[0].status, 429);
}

// (f) Queue capacity is enforced inside the admission batch: from 199 queued
// rows exactly one of two distinct concurrent submissions reaches 200.
{
  const db = new SqliteD1();
  for (let index = 0; index < POLICY.QUEUE_MAX_WAITING - 1; index += 1) {
    insertJob(db, {
      id: `boundary-${index}`,
      account: `boundary-account-${index}`,
      created: index,
    });
  }
  const nearFull = await postEntries(db, [
    { accountId: "boundary-submit-a", prompt: "boundary-a" },
    { accountId: "boundary-submit-b", prompt: "boundary-b" },
  ]);
  assert.deepEqual(nearFull.map((response) => response.status).sort((a, b) => a - b), [201, 503]);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'").count, POLICY.QUEUE_MAX_WAITING);

  const full = await postEntries(db, [
    { accountId: "boundary-submit-c", prompt: "boundary-c" },
    { accountId: "boundary-submit-d", prompt: "boundary-d" },
  ]);
  assert.deepEqual(full.map((response) => response.status), [503, 503]);
  assert.equal(db.scalar("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'").count, POLICY.QUEUE_MAX_WAITING);
}

console.log("PASS verify-queue-concurrency (FIFO claims, one active job, daily cap 2, admission boundary)");
