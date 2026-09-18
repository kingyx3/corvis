import { json } from "@/lib/server/http";

export async function GET() {
  return json({ status: "ok", service: "corvis-web", version: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "development", time: new Date().toISOString() });
}
