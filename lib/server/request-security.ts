const SAFE_METHODS = new Set(["GET", "HEAD"]);

export type BrowserRequestDecision =
  | { allowed: true }
  | { allowed: false; code: "cors_preflight_not_supported" | "cross_origin_browser_request" | "invalid_origin" };

function parsedOrigin(value: string): string | undefined {
  if (value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Corvis browser APIs are same-origin only. Non-browser/service-account clients
 * do not send Origin/Sec-Fetch-Site and continue to authenticate normally.
 *
 * This is a CSRF/CORS boundary, not an authorization boundary: route handlers
 * must still resolve identity and enforce permissions/resource entitlements.
 */
export function checkBrowserRequest(request: Request): BrowserRequestDecision {
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

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) return { allowed: false, code: "cross_origin_browser_request" };

  return { allowed: true };
}
