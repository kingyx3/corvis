import { json } from "@/lib/server/http";
import { checkReadiness } from "@/lib/server/readiness-probe";

// Cloud Run startup probe (#235): unlike /api/v1/health (process liveness), this also requires a
// complete production configuration and a reachable database, so a revision with a missing secret
// or a bad DSN never takes traffic. Unauthenticated, detail-free and cached (lib/server/readiness-probe.ts).
export const dynamic = "force-dynamic";

export async function GET() {
  const { ready } = await checkReadiness();
  return json({ status: ready ? "ok" : "unavailable", service: "corvis-web" }, { status: ready ? 200 : 503 });
}
