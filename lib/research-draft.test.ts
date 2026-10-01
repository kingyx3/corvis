import assert from "node:assert/strict";
import test from "node:test";
import { researchDraftForView } from "./research-draft.ts";

test("a prefilled Ask Corvis draft does not survive navigating to another view", () => {
  const draft = { question: "Explain the conflict", key: 1 };
  assert.equal(researchDraftForView(draft, "overview"), null);
  assert.equal(researchDraftForView(draft, "review"), null);
});

test("staying on Ask Corvis keeps the draft, and an empty draft stays empty", () => {
  const draft = { question: "Explain the conflict", key: 2 };
  assert.equal(researchDraftForView(draft, "research"), draft);
  assert.equal(researchDraftForView(null, "research"), null);
  assert.equal(researchDraftForView(null, "documents"), null);
});
