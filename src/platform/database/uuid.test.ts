import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "./uuid.ts";

test("isUuid accepts canonical UUIDs and rejects anything a ::uuid cast would choke on", () => {
  assert.equal(isUuid("0f7b4c1e-8a2d-4b6f-9c3e-1a2b3c4d5e6f"), true);
  assert.equal(isUuid("0F7B4C1E-8A2D-4B6F-9C3E-1A2B3C4D5E6F"), true);
  for (const bad of ["", "job-1", "not-a-uuid", "0f7b4c1e-8a2d-4b6f-9c3e-1a2b3c4d5e6", undefined, null, 7]) assert.equal(isUuid(bad), false);
});
