import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "./format.ts";

test("formatBytes carries into the next unit when rounding reaches 1024", () => {
  assert.equal(formatBytes(1048575), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1.0 MB");
  assert.equal(formatBytes(1024 ** 3 - 1), "1.0 GB");
});

test("formatBytes keeps ordinary sizes unchanged", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(5 * 1024 ** 2 + 512 * 1024), "5.5 MB");
});
