import assert from "node:assert/strict";
import test from "node:test";
import { documentSecurityNotice } from "./document-processing.ts";

test("maps malware states to plain-language security failure copy", () => {
  assert.deepEqual(documentSecurityNotice({ processingState: "malware_detected" }), {
    label: "Security check failed",
    detail: "This file did not pass Corvis security checks and will not be processed.",
    action: "Verify the source file is safe, then upload a clean copy.",
  });
});

test("maps quarantine and rejection without exposing raw enums", () => {
  for (const processingState of ["quarantined", "rejected", "security_rejected"]) {
    const notice = documentSecurityNotice({ processingState });
    assert.ok(notice);
    assert.equal(JSON.stringify(notice).toLowerCase().includes(processingState), false);
  }
});

test("does not relabel ordinary processing states", () => {
  for (const processingState of ["queued", "running", "blocked", "failed", "dead_letter", undefined]) {
    assert.equal(documentSecurityNotice({ processingState }), null);
  }
});
