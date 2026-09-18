import { getConfig } from "@/server/config";
import { json, requestContext } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const context = requestContext(request);
  const config = getConfig();
  return json({
    status: "ok",
    service: "corvis-web",
    environment: config.environment,
    demoMode: config.demoMode,
    timestamp: new Date().toISOString(),
  }, {}, context.requestId);
}
