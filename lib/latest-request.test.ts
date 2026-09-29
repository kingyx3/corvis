import assert from "node:assert/strict";
import test from "node:test";
import { createLatestRequestGate } from "./latest-request.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slower, older response never overwrites a newer one", async () => {
  const run = createLatestRequestGate();
  const applied: string[] = [];
  const older = deferred<string>();
  const newer = deferred<string>();
  const first = run(() => older.promise, (value) => applied.push(value));
  const second = run(() => newer.promise, (value) => applied.push(value));
  newer.resolve("newer");
  older.resolve("older");
  await Promise.all([first, second]);
  assert.deepEqual(applied, ["newer"]);
});

test("sequential requests each apply, and gates are independent", async () => {
  const run = createLatestRequestGate();
  const other = createLatestRequestGate();
  const applied: string[] = [];
  await run(async () => "a", (value) => applied.push(value));
  await run(async () => "b", (value) => applied.push(value));
  const slow = deferred<string>();
  const pending = run(() => slow.promise, (value) => applied.push(value));
  await other(async () => "other", (value) => applied.push(value));
  slow.resolve("c");
  await pending;
  assert.deepEqual(applied, ["a", "b", "other", "c"]);
});
