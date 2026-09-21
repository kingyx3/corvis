import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
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

  const response = NextResponse.next();
  response.headers.set("cache-control", "no-store");
  if (request.nextUrl.pathname.startsWith("/api/")) response.headers.set("vary", "Origin, Sec-Fetch-Site");
  return response;
}

export const config = {
  matcher: "/:path*",
};
