import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ApiError,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  UnauthenticatedError,
  apiResponseError,
  friendlyErrorMessage,
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
