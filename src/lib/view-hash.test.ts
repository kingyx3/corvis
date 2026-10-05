import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE_VIEWS, parseViewHash, viewHash } from "./view-hash.ts";

test("every view round-trips through its hash", () => {
  for (const view of WORKSPACE_VIEWS) assert.equal(parseViewHash(viewHash(view)), view);
});

test("empty, unknown and element-id hashes are not view routes", () => {
  for (const hash of ["", "#", "#main-content", "#/", "#/nope", "#/review/extra", "#review", "#/Review", "#/review?x=1"]) {
    assert.equal(parseViewHash(hash), null, hash);
  }
});

test("a trailing slash is tolerated", () => {
  assert.equal(parseViewHash("#/documents/"), "documents");
});
