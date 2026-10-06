import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { RateLimitError, RateLimiter } from "../../../../platform/http/limits/rate-limit.ts";
import {
  SOURCE_CONNECT_ATTEMPTS_PER_WINDOW,
  SOURCE_CONNECT_WINDOW_MS,
  enforceSourceConnectAttemptLimit,
  overrideSourceConnectLimiter,
} from "./source-connect-limits.ts";

afterEach(() => overrideSourceConnectLimiter());

function admin(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return { subject: "admin-1", tenantId: "tenant-limits", workspaceId: "workspace-1", roles: ["admin"], entitlements: { workspaceIds: ["workspace-1"] }, authMethod: "demo", sessionId: "s", ...overrides } as RequestIdentity;
}

test("an administrator gets a handful of connect attempts per window and is then told when to try again", () => {
  assert.equal(SOURCE_CONNECT_ATTEMPTS_PER_WINDOW, 10);
  const who = admin({ tenantId: "tenant-limits-default" });
  for (let attempt = 0; attempt < SOURCE_CONNECT_ATTEMPTS_PER_WINDOW; attempt += 1) enforceSourceConnectAttemptLimit(who);
  assert.throws(() => enforceSourceConnectAttemptLimit(who), (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= SOURCE_CONNECT_WINDOW_MS / 1000);
  enforceSourceConnectAttemptLimit(admin({ tenantId: "tenant-limits-default", subject: "admin-2" }));
  enforceSourceConnectAttemptLimit(admin({ tenantId: "tenant-limits-other" }));
});

test("the budget renews when the window has passed, and a pinned limiter replaces the shared one until it is cleared", () => {
  const pinned = new RateLimiter(1, 1_000);
  overrideSourceConnectLimiter(pinned);
  enforceSourceConnectAttemptLimit(admin(), 10_000);
  assert.throws(() => enforceSourceConnectAttemptLimit(admin(), 10_500), RateLimitError);
  enforceSourceConnectAttemptLimit(admin(), 11_000);
  overrideSourceConnectLimiter();
  assert.equal(pinned.size, 1);
  enforceSourceConnectAttemptLimit(admin({ tenantId: "tenant-limits-after-override" }));
  assert.equal(pinned.size, 1, "the pinned limiter is no longer consulted");
});
