import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedAuthContext,
  boundedAuthMethods,
  idpMfaEnforcementLabel,
  MAX_AUTH_CONTEXT_LENGTH,
  MAX_AUTH_METHOD_ENTRIES,
  mfaEvidence,
  mfaEvidenceLabel,
} from "./authentication-evidence.ts";

test("amr entries are validated and bounded; a malformed claim reports less, never more", () => {
  assert.deepEqual(boundedAuthMethods(["pwd", "OTP", " mfa "]), ["pwd", "otp", "mfa"], "entries are trimmed and lower-cased");
  assert.deepEqual(boundedAuthMethods(["pwd", "pwd"]), ["pwd"], "duplicates collapse");
  assert.deepEqual(boundedAuthMethods("pwd"), [], "a string is not an array of methods");
  assert.deepEqual(boundedAuthMethods(undefined), []);
  assert.deepEqual(boundedAuthMethods({ 0: "pwd" }), []);
  assert.deepEqual(boundedAuthMethods(["pwd", 7, null, { a: 1 }, "has space", "x".repeat(33), "", "-lead", "bad\u0000", "otp"]), ["pwd", "otp"], "anything that is not a short identifier is dropped");
  const many = Array.from({ length: 50 }, (_, index) => `m${index}`);
  assert.equal(boundedAuthMethods(many).length, MAX_AUTH_METHOD_ENTRIES, "no more than the bound is kept");
});

test("acr is kept only as a bounded printable identifier", () => {
  assert.equal(boundedAuthContext("urn:mace:incommon:iap:silver"), "urn:mace:incommon:iap:silver");
  assert.equal(boundedAuthContext("2"), "2");
  assert.equal(boundedAuthContext(2), undefined);
  assert.equal(boundedAuthContext(""), undefined);
  assert.equal(boundedAuthContext("two words"), undefined);
  assert.equal(boundedAuthContext("line\nbreak"), undefined);
  assert.equal(boundedAuthContext("a".repeat(MAX_AUTH_CONTEXT_LENGTH)), "a".repeat(MAX_AUTH_CONTEXT_LENGTH));
  assert.equal(boundedAuthContext("a".repeat(MAX_AUTH_CONTEXT_LENGTH + 1)), undefined);
});

test("MFA evidence is claimed only for what the methods show", () => {
  assert.equal(mfaEvidence([]), null, "no amr: nothing is known");
  assert.equal(mfaEvidence(["mfa"]), true, "the identity provider said so");
  assert.equal(mfaEvidence(["pwd", "otp"]), true, "knowledge and possession");
  assert.equal(mfaEvidence(["pwd", "fpt"]), true, "knowledge and inherence");
  assert.equal(mfaEvidence(["hwk", "face"]), true, "possession and inherence");
  assert.equal(mfaEvidence(["pwd"]), false, "a single factor");
  assert.equal(mfaEvidence(["pwd", "pin", "kba"]), false, "three knowledge factors are still one category");
  assert.equal(mfaEvidence(["hwk"]), false, "a key on its own is not shown to be MFA");
  assert.equal(mfaEvidence(["user"]), false, "an unrecognised method adds no factor");
});

test("labels never say more than the evidence", () => {
  assert.match(mfaEvidenceLabel(true), /^MFA used/);
  assert.match(mfaEvidenceLabel(false), /without a second factor/);
  assert.match(mfaEvidenceLabel(null), /Not reported/);
  assert.match(idpMfaEnforcementLabel(true), /^Yes/);
  assert.match(idpMfaEnforcementLabel(false), /^No/);
  assert.match(idpMfaEnforcementLabel(null), /Not reported/);
});
