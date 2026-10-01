import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "./format.ts";

test("formatBytes handles zero, byte, kilobyte, megabyte, and capped gigabyte ranges", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1.5 * 1024 ** 2), "1.5 MB");
  assert.equal(formatBytes(2 * 1024 ** 4), "2048.0 GB");
});
