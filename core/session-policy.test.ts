import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionPolicyUpdate,
  parseSignOutEverywhere,
  SESSION_IDLE_TIMEOUT_BOUNDS,
  SESSION_MAX_LENGTH_BOUNDS,
  sessionLimitLabel,
  SessionPolicyValidationError,
} from "./session-policy.ts";

const valid = { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Align with our security policy" };
const code = (run: () => unknown): string => {
  try { run(); return "ok"; } catch (error) { assert.ok(error instanceof SessionPolicyValidationError); assert.equal(error.status, 400); return error.code; }
};

test("a policy change states both limits, the version it is based on and why", () => {
  assert.deepEqual(parseSessionPolicyUpdate(valid), valid);
  assert.equal(parseSessionPolicyUpdate({ ...valid, reason: "  padded reason  " }).reason, "padded reason");
  assert.equal(code(() => parseSessionPolicyUpdate(null)), "invalid_request");
  assert.equal(code(() => parseSessionPolicyUpdate([])), "invalid_request");
  assert.equal(code(() => parseSessionPolicyUpdate({ maxSessionMinutes: 480, expectedVersion: 0, reason: valid.reason })), "invalid_request", "a missing limit is not guessed to mean keep or clear");
  assert.equal(code(() => parseSessionPolicyUpdate({ idleTimeoutMinutes: 30, expectedVersion: 0, reason: valid.reason })), "invalid_request");
});

test("a limit can be cleared with null but never set outside the Corvis bounds", () => {
  assert.deepEqual(parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: null, maxSessionMinutes: null }), { ...valid, idleTimeoutMinutes: null, maxSessionMinutes: null });
  const edges = parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS.min, maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS.max });
  assert.deepEqual([edges.idleTimeoutMinutes, edges.maxSessionMinutes], [15, 10080]);
  assert.equal(parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS.max, maxSessionMinutes: null }).idleTimeoutMinutes, 480);
  assert.equal(parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: null, maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS.min }).maxSessionMinutes, 60);
  for (const bad of [14, 481, 0, -5, 30.5, "30", undefined, Number.NaN, Infinity]) {
    assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: bad })), "invalid_idle_timeout", String(bad));
  }
  for (const bad of [59, 10081, 0, 90.5, "480", undefined, Number.NaN]) {
    assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, maxSessionMinutes: bad })), "invalid_max_session", String(bad));
  }
});

test("the idle timeout can never exceed the session length", () => {
  assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: 120, maxSessionMinutes: 60 })), "idle_exceeds_max_session");
  assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: 60, maxSessionMinutes: 60 })), "ok");
  assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, idleTimeoutMinutes: 480, maxSessionMinutes: null })), "ok", "a single limit has nothing to compare with");
});

test("the version a change is based on and the reason are required and checked", () => {
  for (const bad of [-1, 1.5, "1", undefined, null]) {
    assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, expectedVersion: bad })), "invalid_version", String(bad));
  }
  for (const bad of ["ab", "  ab  ", "x".repeat(1001), "bad\u0000reason", "bad\u2028reason", 7, undefined, null]) {
    assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, reason: bad })), "invalid_reason", String(bad));
  }
  assert.equal(code(() => parseSessionPolicyUpdate({ ...valid, reason: "line one\nline two\tok" })), "ok", "line breaks and tabs are allowed in free text");
});

test("signing a user out names a user id and a reason", () => {
  const userId = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
  assert.deepEqual(parseSignOutEverywhere({ userId: ` ${userId.toUpperCase()} `, reason: " Left the firm " }), { userId, reason: "Left the firm" });
  assert.equal(code(() => parseSignOutEverywhere(undefined)), "invalid_request");
  assert.equal(code(() => parseSignOutEverywhere({ reason: "why not" })), "invalid_user");
  assert.equal(code(() => parseSignOutEverywhere({ userId: "not-a-uuid", reason: "why not" })), "invalid_user");
  assert.equal(code(() => parseSignOutEverywhere({ userId, reason: "" })), "invalid_reason");
});

test("limits read in plain language", () => {
  assert.equal(sessionLimitLabel(null), "No limit set");
  assert.equal(sessionLimitLabel(15), "15 minutes");
  assert.equal(sessionLimitLabel(60), "1 hour");
  assert.equal(sessionLimitLabel(480), "8 hours");
  assert.equal(sessionLimitLabel(90), "90 minutes");
  assert.equal(sessionLimitLabel(1440), "1 day");
  assert.equal(sessionLimitLabel(10080), "7 days");
});
