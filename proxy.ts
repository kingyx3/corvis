import { NextRequest, NextResponse } from "next/server";

function contentSecurityPolicy(nonce: string): string {
  const uploadOrigin = process.env.NEXT_PUBLIC_CORVIS_UPLOAD_ORIGIN?.trim();
  const connectSources = ["'self'", uploadOrigin].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const production = process.env.CORVIS_ENV === "production" || process.env.NODE_ENV === "production";
  const demoMode = process.env.CORVIS_DEMO_MODE === "true" && !production;
  const cookieName = production ? "__Host-corvis_session" : "corvis_session";

  if (!demoMode && !request.cookies.get(cookieName)?.value) {
    const login = new URL("/api/auth/login", request.url);
    login.searchParams.set("returnTo", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-request-id", request.headers.get("x-request-id") || crypto.randomUUID());
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
