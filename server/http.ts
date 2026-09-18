import { randomUUID } from "node:crypto";

export type RequestContext = { requestId: string };

export function requestContext(request: Request): RequestContext {
  const incoming = request.headers.get("x-request-id")?.trim();
  return { requestId: incoming && incoming.length <= 100 ? incoming : randomUUID() };
}

export function json(data: unknown, init: ResponseInit = {}, requestId?: string): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  if (requestId) headers.set("x-request-id", requestId);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function problem(error: unknown, requestId?: string): Response {
  const typed = error as { status?: number; code?: string; message?: string };
  const status = Number.isInteger(typed?.status) ? Number(typed.status) : 500;
  const code = typed?.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED");
  const detail = status >= 500 ? "The request could not be completed." : typed?.message || "Request failed";
  return json({ type: `https://corvis.app/problems/${code.toLowerCase()}`, title: code, status, detail, requestId }, { status }, requestId);
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415, code: "CONTENT_TYPE_REQUIRED" });
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "REQUEST_TOO_LARGE" });
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "REQUEST_TOO_LARGE" });
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400, code: "JSON_INVALID" });
  }
}

export function noContent(requestId?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (requestId) headers.set("x-request-id", requestId);
  return new Response(null, { status: 204, headers });
}
