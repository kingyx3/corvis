import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ApiError,
  SESSION_ENDED_BY_POLICY_MESSAGE,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  UnauthenticatedError,
  apiResponseError,
  friendlyErrorMessage,
  sessionEndedByPolicy,
  sessionExpiredCopy,
  sessionExpiredError,
  throwIfUnauthenticated,
} from "./api-errors.ts";
import { latestRequestCorrelationId } from "./request-correlation.ts";

afterEach(() => { Reflect.deleteProperty(globalThis, "window"); });

function recordEvents(): string[] {
  const fired: string[] = [];
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: (event: Event) => { fired.push(event.type); return true; } }, configurable: true });
  return fired;
}

test("throwIfUnauthenticated throws the typed error with user-facing copy and fires the session-expired event on a 401 only", () => {
  const fired = recordEvents();
  throwIfUnauthenticated({ status: 200 });
  throwIfUnauthenticated({ status: 403 });
  throwIfUnauthenticated({ status: 500 });
  assert.deepEqual(fired, []);
  assert.throws(() => throwIfUnauthenticated({ status: 401 }), (error: unknown) => {
    assert.ok(error instanceof UnauthenticatedError);
    assert.equal(error.status, 401);
    assert.equal(error.message, SESSION_EXPIRED_MESSAGE);
    assert.equal(friendlyErrorMessage(error, "fallback"), SESSION_EXPIRED_MESSAGE);
    return true;
  });
  assert.deepEqual(fired, [SESSION_EXPIRED_EVENT]);
});

test("sessionExpiredError is safe outside a browser", () => {
  assert.ok(sessionExpiredError() instanceof UnauthenticatedError);
});

test("apiResponseError remembers the failing request's correlation id for Contact support", async () => {
  await apiResponseError(new Response(JSON.stringify({ error: "internal_error", correlationId: "corr-body-1" }), { status: 500 }));
  assert.equal(latestRequestCorrelationId(), "corr-body-1");
  await apiResponseError(new Response("<html>bad gateway</html>", { status: 502, headers: { "x-correlation-id": "corr-header-2" } }));
  assert.equal(latestRequestCorrelationId(), "corr-header-2");
});

test("apiResponseError maps 401 to UnauthenticatedError (keeping the server code) and other statuses to ApiError", async () => {
  const fired = recordEvents();
  const unauthenticated = await apiResponseError(new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }));
  assert.ok(unauthenticated instanceof UnauthenticatedError);
  assert.equal(unauthenticated.code, "authentication_required");
  assert.deepEqual(fired, [SESSION_EXPIRED_EVENT]);

  const invalid = await apiResponseError(new Response(JSON.stringify({ error: "validation_failed", reasons: ["a is required", "b is invalid"] }), { status: 422 }));
  assert.ok(invalid instanceof ApiError && !(invalid instanceof UnauthenticatedError));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.message, "validation_failed: a is required; b is invalid");

  const opaque = await apiResponseError(new Response("<html>bad gateway</html>", { status: 502 }));
  assert.equal(opaque.message, "Corvis API request failed (502)");
  assert.deepEqual(fired, [SESSION_EXPIRED_EVENT], "only the 401 fired the event");
});

test("F7c: a 401 coded session_ended_by_policy tells the person why, a generic coded 401 resets it, and an uncoded one leaves it", async () => {
  const fired = recordEvents();
  await apiResponseError(new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }));
  assert.equal(sessionEndedByPolicy(), false);
  assert.equal(sessionExpiredCopy().title, "Your session has expired");

  const ended = await apiResponseError(new Response(JSON.stringify({ error: "session_ended_by_policy", correlationId: "c-1" }), { status: 401 }));
  assert.ok(ended instanceof UnauthenticatedError);
  assert.equal(ended.code, "session_ended_by_policy");
  assert.equal(sessionEndedByPolicy(), true, "set before the shell is told, so the banner it renders has the right words");
  assert.deepEqual(fired.slice(-1), [SESSION_EXPIRED_EVENT]);
  assert.equal(friendlyErrorMessage(ended, "fallback"), SESSION_ENDED_BY_POLICY_MESSAGE);
  assert.equal(sessionExpiredCopy().title, "Your session ended by organization policy");
  assert.match(sessionExpiredCopy().detail, /sign-in policy ended this session/);

  // A raw fetch caller that cannot read the body does not erase what was learned.
  assert.throws(() => throwIfUnauthenticated({ status: 401 }), UnauthenticatedError);
  assert.equal(sessionEndedByPolicy(), true);
  assert.equal(friendlyErrorMessage(sessionExpiredError(), "fallback"), SESSION_EXPIRED_MESSAGE);

  await apiResponseError(new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }));
  assert.equal(sessionEndedByPolicy(), false);
  assert.equal(sessionExpiredCopy().title, "Your session has expired");
});
