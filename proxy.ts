import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "./lib/server/content-security-policy";
import { checkBrowserRequest } from "./lib/server/request-security";
import { resolveRuntimeSurface, runtimeSurfaceAllows } from "./lib/server/runtime-surface";

export function proxy(request: NextRequest) {
  const surface = resolveRuntimeSurface(process.env.CORVIS_RUNTIME_SURFACE, {
    nodeEnv: process.env.NODE_ENV,
    demoMode: process.env.CORVIS_DEMO_MODE,
    serviceName: process.env.K_SERVICE,
  });

  if (!runtimeSurfaceAllows(surface, request.nextUrl.pathname)) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-corvis-runtime-surface": surface,
      },
    });
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    const decision = checkBrowserRequest(request);
    if (!decision.allowed) {
      return NextResponse.json(
        { error: decision.code },
        {
          status: 403,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            vary: "Origin, Sec-Fetch-Site",
          },
        },
      );
    }
  }

  // Every route is dynamically rendered (see app/layout.tsx's `connection()`), so a fresh nonce
  // per request is safe: nothing here is cached or reused across requests (cache-control: no-store
  // below applies to every response, so there is no static shell that could serve a stale nonce).
  const isProduction = process.env.NODE_ENV === "production";
  const requestHeaders = new Headers(request.headers);
  let contentSecurityPolicy: string | undefined;
  if (isProduction) {
    const nonce = generateNonce();
    contentSecurityPolicy = buildContentSecurityPolicy({ nonce, isDev: false });
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", contentSecurityPolicy);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("cache-control", "no-store");
  if (request.nextUrl.pathname.startsWith("/api/")) response.headers.set("vary", "Origin, Sec-Fetch-Site");
  if (contentSecurityPolicy) response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: "/:path*",
};
