#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY, dailyCapFor } from "../../workers/api/src/policy.js";
import { claimNext, positionOf } from "../../workers/api/src/queue.js";
import { normalizePrompt, promptHash, validatePrompt } from "../../workers/api/src/prompt.js";
import { DURATION_MAX, PROMPT_MAX_CHARS } from "../../tools/ardy/prompt-limits.mjs";

class StubStatement {
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
    return this.db.first(this.sql, this.args);
  }

  async run() {
    return this.db.run(this.sql, this.args);
  }
}

/** A small D1-shaped adapter for the pure FIFO claim contract. */
class QueueStubDb {
  constructor() {
    this.jobs = [];
  }

  prepare(sql) {
    return new StubStatement(this, sql);
  }

  async first(sql) {
    if (!sql.includes("SELECT id, token, account_id, prompt, created_at, attempts")) {
      throw new Error(`unexpected queue query: ${sql}`);
    }
    return this.jobs
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0] ?? null;
  }

  async run(sql, args) {
    assert.match(sql, /UPDATE jobs SET status='running'/u);
    const [leaseToken, workerId, leaseExpiresAt, startedAt, id] = args;
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job || job.status !== "queued") return { meta: { changes: 0 } };
    job.status = "running";
    job.lease_token = leaseToken;
    job.lease_owner = workerId;
    job.lease_expires_at = leaseExpiresAt;
    job.started_at ??= startedAt;
    job.attempts += 1;
    return { meta: { changes: 1 } };
  }
}

const policySource = readFileSync(new URL("../../workers/api/src/policy.js", import.meta.url), "utf8");
const queueSource = readFileSync(new URL("../../workers/api/src/queue.js", import.meta.url), "utf8");
// The studio-side bridge caps live in src/app-stage.jsx (module-level
// constants extracted from App.jsx); this guard keeps them equal to the
// shared prompt-limit contract.
const appSource = readFileSync(new URL("../../src/app-stage.jsx", import.meta.url), "utf8");
const promptLimitsSource = readFileSync(new URL("../../tools/ardy/prompt-limits.mjs", import.meta.url), "utf8");

// The hosted v1 queue has one FIFO order and one account-wide daily cap.
assert.equal(POLICY.DAILY_CAP, 2);
assert.equal(dailyCapFor(), 2);
assert.equal(POLICY.ACTIVE_JOBS_PER_ACCOUNT, 1);
assert.equal(POLICY.DEMO_DURATION_S, 4);
assert.equal("LANE_PHASES" in POLICY, false);
assert.doesNotMatch(policySource, /\blaneFor\b|\bLANE_PHASES\b|\bpriority\b|\bstarVerified\b/iu);
assert.doesNotMatch(queueSource, /\blane\b|\bpriority\b|\bdrain(?:ed|ing)?\b/iu);

assert.equal(POLICY.PROMPT_MAX_CHARS, PROMPT_MAX_CHARS);
assert.equal(Number(promptLimitsSource.match(/PROMPT_MAX_CHARS\s*=\s*(\d+)/u)?.[1]), PROMPT_MAX_CHARS);
assert.equal(Number(promptLimitsSource.match(/DURATION_MAX\s*=\s*(\d+)/u)?.[1]), DURATION_MAX);
assert.equal(Number(appSource.match(/ARDY_PROMPT_MAX\s*=\s*(\d+)/u)?.[1]), PROMPT_MAX_CHARS);
assert.equal(Number(appSource.match(/ARDY_DURATION_MAX\s*=\s*(\d+)/u)?.[1]), DURATION_MAX);

assert.equal(normalizePrompt("  A WALK   FORWARD!!! "), "a walk forward");
assert.equal(await promptHash("A walk forward."), await promptHash(" a   WALK forward "));
assert.equal(validatePrompt(""), "field 'prompt' must be a non-empty string");
assert.equal(validatePrompt("x"), null);
assert.match(validatePrompt("x".repeat(PROMPT_MAX_CHARS + 1)), /cap is 500/u);

// Position is the count of queued rows ahead plus one; no lane weighting is
// involved in the v1 ticket contract.
assert.equal(positionOf({ a: 0 }), 1);
assert.equal(positionOf({ a: 4 }), 5);
assert.equal(positionOf({ a: -4 }), 1);
assert.equal(positionOf({ a: "3" }), 4);

const db = new QueueStubDb();
for (const [id, createdAt] of [["z", 2], ["b", 1], ["a", 1], ["c", 3]]) {
  db.jobs.push({
    id,
    token: `token-${id}`,
    account_id: `account-${id}`,
    prompt: `prompt-${id}`,
    created_at: createdAt,
    attempts: 0,
    status: "queued",
  });
}
const claims = [];
for (let index = 0; index < db.jobs.length; index += 1) {
  const claim = await claimNext({ DB: db }, "fifo-worker");
  assert.ok(claim);
  claims.push(claim);
}
assert.deepEqual(claims.map((claim) => claim.jobId), ["a", "b", "z", "c"]);
assert.equal(new Set(claims.map((claim) => claim.leaseToken)).size, claims.length);
assert.equal(claims[0].durationS, POLICY.DEMO_DURATION_S);
assert.equal(claims[0].duration, POLICY.DEMO_DURATION_S);
assert.equal(claims[0].job_id, claims[0].jobId);
assert.equal(claims[0].lease_token, claims[0].leaseToken);
assert.equal(await claimNext({ DB: db }, "fifo-worker"), null);

// A queued row with the same timestamp is ordered by its stable id tie-breaker.
const tieDb = new QueueStubDb();
tieDb.jobs.push(
  { id: "same-b", token: "same-b", account_id: "b", prompt: "b", created_at: 10, attempts: 0, status: "queued" },
  { id: "same-a", token: "same-a", account_id: "a", prompt: "a", created_at: 10, attempts: 0, status: "queued" },
);
assert.equal((await claimNext({ DB: tieDb }, "tie-worker")).jobId, "same-a");
assert.equal((await claimNext({ DB: tieDb }, "tie-worker")).jobId, "same-b");

console.log("PASS verify-queue-policy (single FIFO queue, daily cap 2, shared prompt limits)");
