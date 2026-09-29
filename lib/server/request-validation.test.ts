import assert from "node:assert/strict";
import test from "node:test";
import { isNonEmptyString, MAX_VERSION } from "./request-validation.ts";

test("isNonEmptyString accepts only strings with visible content", () => {
  assert.equal(isNonEmptyString("a"), true);
  assert.equal(isNonEmptyString(" a "), true);
  for (const value of ["", "   ", "\n\t", null, undefined, 0, 1, {}, [], ["a"], true]) {
    assert.equal(isNonEmptyString(value), false, JSON.stringify(value));
  }
});

test("MAX_VERSION is the largest Postgres integer, so version columns can never overflow", () => {
  assert.equal(MAX_VERSION, 2 ** 31 - 1);
});
