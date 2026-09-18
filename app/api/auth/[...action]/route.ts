import { handleAuth } from "@/server/auth-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ action: string[] }> }): Promise<Response> {
  const { action } = await context.params;
  return handleAuth(request, action?.[0] || "");
}

export const GET = handle;
export const POST = handle;
