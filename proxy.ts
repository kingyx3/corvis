import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkBrowserRequest } from "./lib/server/request-security";

export function proxy(request: NextRequest) {
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

  const response = NextResponse.next();
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Origin, Sec-Fetch-Site");
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
