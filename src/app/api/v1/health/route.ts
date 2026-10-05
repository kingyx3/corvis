import { json } from "@/platform/http/api/http";

// Unauthenticated liveness probe. It deliberately reports nothing about the
// build (commit SHA, version) or the clock: callers only need status and the
// no-store/nosniff headers. Never prerender it into a static response.
export const dynamic = "force-dynamic";

export async function GET() {
  return json({ status: "ok", service: "corvis-web" });
}
