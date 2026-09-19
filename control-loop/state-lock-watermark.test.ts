import assert from "node:assert/strict";
import test from "node:test";
import { acquireLock, releaseLock } from "./lock.ts";
import { InMemoryStateStore } from "./state.ts";
import { emptyWatermark, readWatermark, writeWatermark } from "./watermark.ts";

test("InMemoryStateStore round-trips a write through read and clears on a null write", async () => {
  const store = new InMemoryStateStore();
  assert.equal(await store.read("k"), null);
  await store.write("k", "v");
  assert.equal(await store.read("k"), "v");
  await store.write("k", null);
  assert.equal(await store.read("k"), null);
});

test("readWatermark returns the empty watermark when nothing has ever been written", async () => {
  const watermark = await readWatermark(new InMemoryStateStore());
  assert.deepEqual(watermark, emptyWatermark());
});

test("readWatermark degrades to empty on corrupted or schema-mismatched content instead of throwing", async () => {
  const store = new InMemoryStateStore();
  await store.write("watermark", "not json");
  assert.deepEqual(await readWatermark(store), emptyWatermark());

  await store.write("watermark", JSON.stringify({ schemaVersion: 999 }));
  assert.deepEqual(await readWatermark(store), emptyWatermark());
});

test("writeWatermark then readWatermark round-trips exactly", async () => {
  const store = new InMemoryStateStore();
  const value = { ...emptyWatermark(), lastSuccessfulDailyRunAt: "2026-09-19T00:00:00.000Z", consecutiveFailures: 1 };
  await writeWatermark(store, value);
  assert.deepEqual(await readWatermark(store), value);
});

test("acquireLock succeeds when no lock is held, and the same owner can reacquire it", async () => {
  const store = new InMemoryStateStore();
  const now = new Date("2026-09-19T00:00:00.000Z");
  assert.deepEqual(await acquireLock(store, "runner-a", now, 60_000), { acquired: true });
  assert.deepEqual(await acquireLock(store, "runner-a", now, 60_000), { acquired: true });
});

test("acquireLock refuses a different owner while a fresh lock is held", async () => {
  const store = new InMemoryStateStore();
  const now = new Date("2026-09-19T00:00:00.000Z");
  await acquireLock(store, "runner-a", now, 60_000);
  const result = await acquireLock(store, "runner-b", now, 60_000);
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.equal(result.heldBy.owner, "runner-a");
});

test("acquireLock reclaims a stale lock from a different, presumably crashed, owner", async () => {
  const store = new InMemoryStateStore();
  const acquiredAt = new Date("2026-09-19T00:00:00.000Z");
  await acquireLock(store, "runner-a", acquiredAt, 60_000);
  const later = new Date(acquiredAt.getTime() + 61_000);
  const result = await acquireLock(store, "runner-b", later, 60_000);
  assert.equal(result.acquired, true);
});

test("releaseLock only clears a lock this owner actually holds", async () => {
  const store = new InMemoryStateStore();
  const now = new Date("2026-09-19T00:00:00.000Z");
  await acquireLock(store, "runner-a", now, 60_000);
  await releaseLock(store, "runner-b");
  assert.equal((await acquireLock(store, "runner-c", now, 60_000)).acquired, false, "an unrelated owner's release must not clear another owner's lock");

  await releaseLock(store, "runner-a");
  assert.equal((await acquireLock(store, "runner-c", now, 60_000)).acquired, true);
});

test("releaseLock on an already-clear lock is a safe no-op", async () => {
  const store = new InMemoryStateStore();
  await releaseLock(store, "runner-a");
  assert.equal((await acquireLock(store, "runner-b", new Date(), 60_000)).acquired, true);
});
