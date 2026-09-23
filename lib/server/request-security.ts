const SAFE_METHODS = new Set(["GET", "HEAD"]);

export type BrowserRequestDecision =
  | { allowed: true }
  | { allowed: false; code: "cors_preflight_not_supported" | "cross_origin_browser_request" | "invalid_origin" };

export type BrowserRequestPolicy = {
  /** Public browser origins (scheme://host[:port]) that may issue state-changing API calls. */
  allowedOrigins: string[];
  production: boolean;
};

function parsedOrigin(value: string): string | undefined {
  if (value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Reads the browser-origin policy from process.env only, so it is safe in the
 * Next proxy runtime (no node-only imports, no server-config side effects).
 *
 * CORVIS_BROWSER_ALLOWED_ORIGINS is a comma-separated list of the public
 * customer/admin origins (Terraform sets it on the API service). Deployed
 * traffic reaches the API through Cloudflare -> API Gateway -> Cloud Run, so
 * the request URL the runtime sees (bind address or run.app host) never equals
 * the browser's public origin; the explicit allow-list is authoritative there.
 */
export function browserRequestPolicyFromEnv(env: Record<string, string | undefined> = process.env): BrowserRequestPolicy {
  const allowedOrigins = (env.CORVIS_BROWSER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      const origin = parsedOrigin(value);
      return origin ? [origin] : [];
    });
  return { allowedOrigins, production: env.NODE_ENV === "production" };
}

/**
 * Corvis browser APIs accept state-changing requests only from Corvis' own
 * public origins. Non-browser/service-account clients do not send
 * Origin/Sec-Fetch-Site and continue to authenticate normally.
 *
 * Origin matching:
 * - an Origin in the configured allow-list is accepted;
 * - in production with a configured allow-list, nothing else is accepted;
 * - otherwise (local/dev/e2e, or production without an allow-list such as a
 *   local `next start`) the Origin must equal the request URL's own origin.
 *
 * This is a CSRF/CORS boundary, not an authorization boundary: route handlers
 * must still resolve identity and enforce permissions/resource entitlements.
 */
export function checkBrowserRequest(request: Request, policy: BrowserRequestPolicy = browserRequestPolicyFromEnv()): BrowserRequestDecision {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return { allowed: false, code: "cors_preflight_not_supported" };
  if (SAFE_METHODS.has(method)) return { allowed: true };

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return { allowed: false, code: "cross_origin_browser_request" };
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) return { allowed: true };

  const origin = parsedOrigin(originHeader);
  if (!origin) return { allowed: false, code: "invalid_origin" };

  if (policy.allowedOrigins.includes(origin)) return { allowed: true };
  if (policy.production && policy.allowedOrigins.length > 0) return { allowed: false, code: "cross_origin_browser_request" };

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) return { allowed: false, code: "cross_origin_browser_request" };

  return { allowed: true };
}
