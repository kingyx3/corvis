import { beginOidcLogin, finishOidcLogin, logoutResponse } from "@/server/security";
import { problem, requestContext } from "@/server/http";

export async function handleAuth(request: Request, action: string): Promise<Response> {
  const context = requestContext(request);
  try {
    if (request.method === "GET" && action === "login") return beginOidcLogin(request);
    if (request.method === "GET" && action === "callback") return finishOidcLogin(request);
    if ((request.method === "POST" || request.method === "GET") && action === "logout") return logoutResponse();
    throw Object.assign(new Error("Authentication endpoint not found"), { status: 404, code: "NOT_FOUND" });
  } catch (error) {
    return problem(error, context.requestId);
  }
}
