import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import type { PostgresSqlApi } from "../database/postgres.ts";
import { checkReadiness, resetReadinessCache } from "./readiness-probe.ts";

console.error = () => undefined;
const env = { ...process.env };
beforeEach(() => {
  resetReadinessCache();
  process.env = { ...env, NODE_ENV: "production", CORVIS_DEMO_MODE: "false", CORVIS_AUTH_ISSUER: "https://issuer.test", CORVIS_AUTH_AUDIENCE: "aud", CORVIS_DATABASE_DSN: "postgres://u:p@db.test/x", CORVIS_OBJECT_STORE_BUCKET: "b" };
});

const db = (health: () => Promise<boolean>): PostgresSqlApi => ({ async query() { return []; }, async execute() {}, health });

test("ready when production configuration is complete and the database answers", async () => {
  assert.deepEqual(await checkReadiness({ db: () => db(async () => true) }), { ready: true });
});

test("not ready when a production secret is missing, without touching the database", async () => {
  delete process.env.CORVIS_DATABASE_DSN;
  let called = false;
  assert.deepEqual(await checkReadiness({ db: () => { called = true; return db(async () => true); } }), { ready: false });
  assert.equal(called, false);
});

test("not ready when the database is down or hangs", async () => {
  assert.deepEqual(await checkReadiness({ db: () => db(async () => false) }), { ready: false });
  resetReadinessCache();
  assert.deepEqual(await checkReadiness({ db: () => db(async () => { throw new Error("ECONNREFUSED"); }) }), { ready: false });
});

test("a database health check that never answers makes the probe not ready instead of hanging it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = checkReadiness({ db: () => db(() => new Promise<boolean>(() => undefined)) });
    mock.timers.tick(60_000);
    assert.deepEqual(await pending, { ready: false });
  } finally {
    mock.timers.reset();
  }
});

test("results are cached briefly so the public probe cannot load the database", async () => {
  let clock = 0; let calls = 0;
  const probe = () => checkReadiness({ now: () => clock, db: () => db(async () => { calls += 1; return true; }) });
  await probe(); await probe();
  assert.equal(calls, 1);
  clock = 10_001;
  await probe();
  assert.equal(calls, 2);
});

test("logging an event never throws, even when the production configuration is incomplete", async () => {
  delete process.env.CORVIS_AUTH_ISSUER;
  const { logEvent } = await import("./telemetry.ts");
  assert.doesNotThrow(() => logEvent("error", "test.event", { correlationId: "c" }));
});
