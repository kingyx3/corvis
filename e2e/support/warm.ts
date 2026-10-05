import type { APIRequestContext } from "@playwright/test";

/**
 * Under `next dev` every route handler is compiled the first time it is requested, and on a cold server that can take far
 * longer than an assertion's 10 s (the first call to an API route a test depends on is the one that pays for it). A test
 * that asserts on what such a route returns would then time out on the compile, not on the behavior. Requesting each route
 * once up front, in a `beforeAll`, moves that cost out of the assertion. It does not raise any timeout and it does not hide
 * a failure: the warm-up ignores the response (a 404 for an id that does not exist is as good as a 200 for compiling the
 * handler), and the test still asserts on its own, isolated, requests.
 *
 * Warm-up requests use their own demo tenant, so anything they touch is never seen by a test.
 */
export type WarmRequest = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; data?: unknown };

const WARMUP_TENANT = "e2e-warmup";
/** A cold compile of one route is a few seconds to a minute on a busy runner; the request is the only thing waiting. */
const WARMUP_TIMEOUT_MS = 90_000;

export async function warmApiRoutes(request: APIRequestContext, routes: readonly WarmRequest[], roles = "admin"): Promise<void> {
  const headers = { "x-corvis-demo-tenant": WARMUP_TENANT, "x-corvis-demo-roles": roles };
  // One at a time: compiling in parallel only makes each of them slower, and the order is the order the page asks for them.
  for (const route of routes) {
    await request.fetch(route.path, { method: route.method ?? "GET", headers, timeout: WARMUP_TIMEOUT_MS, ...(route.data === undefined ? {} : { data: route.data }) }).catch(() => undefined);
  }
}
