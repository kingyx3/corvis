import assert from "node:assert/strict";
import test from "node:test";
import { errorClassOf, LAST_ERROR_MAX_CHARS, redactErrorText, safeErrorText } from "./processing-error-text.ts";

test("safeErrorText keeps a stable class and drops bearer tokens, JWTs, signed URL queries and provider bodies", () => {
  // Fake credentials are assembled at runtime so no literal in this file matches a real secret format
  // (repository push protection scans source text).
  const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0NTYifQ", "c2lnbmF0dXJlLXZhbHVl"].join(".");
  const fakeStripeKey = ["sk", "live", "0123456789abcdef0123456789abcdef"].join("_");
  const error = new Error(
    `provider failed (502) Bearer ya29.a0AfH6SMBx-secret-token-value url=https://user:hunter2@bucket.example/o/x?X-Goog-Signature=abcdef&token=zzz jwt=${jwt} body={"error":{"message":"api_key=${fakeStripeKey}"}}`,
  );
  error.name = "ProviderError";
  const text = safeErrorText(error);
  assert.match(text, /^ProviderError: provider failed \(502\)/);
  for (const secret of ["ya29", "hunter2", "abcdef&", "zzz", jwt, "sk_live", "X-Goog-Signature"]) {
    assert.equal(text.includes(secret), false, `${secret} must not be persisted`);
  }
  assert.ok(text.length <= LAST_ERROR_MAX_CHARS);
});

test("safeErrorText redacts key=value secrets and opaque tokens but keeps UUIDs and hex digests", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const sha = "a".repeat(64);
  const text = safeErrorText(new Error(`password=hunter2 secret: "topsecret" opaque=Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Ng tenant ${uuid} sha ${sha}`));
  assert.equal(/hunter2|topsecret|Zm9vYmFy/.test(text), false);
  assert.ok(text.includes(uuid));
  assert.ok(text.includes(sha));
});

test("safeErrorText bounds length, strips control characters and classifies non-errors", () => {
  const text = safeErrorText(new Error(`line1\nline2\u0000${"x ".repeat(2_000)}`));
  assert.ok(text.length <= LAST_ERROR_MAX_CHARS);
  assert.equal(/[\u0000-\u001f]/.test(text), false);
  assert.equal(errorClassOf("boom"), "NonError");
  assert.equal(safeErrorText("plain failure"), "NonError: plain failure");
  assert.equal(errorClassOf(Object.assign(new Error("x"), { code: "ECONNRESET" })), "ECONNRESET");
  assert.equal(redactErrorText("y".repeat(3_000), 2_000).length, 2_000);
});

test("redaction is idempotent so sinks may re-apply it safely", () => {
  const once = safeErrorText(new Error("token=abc123 Bearer xyz.abc"));
  assert.equal(redactErrorText(once), once);
});
