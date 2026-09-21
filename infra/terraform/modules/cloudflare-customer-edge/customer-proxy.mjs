function gatewayTarget(request, env) {
  const url = new URL(request.url);
  const isApi = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
  const host = isApi ? env.API_GATEWAY_HOST : env.CUSTOMER_GATEWAY_HOST;
  const key = isApi ? env.API_GATEWAY_API_KEY : env.CUSTOMER_GATEWAY_API_KEY;

  const target = new URL(request.url);
  target.protocol = "https:";
  target.hostname = host;
  target.port = "";

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-api-key");
  headers.set("x-api-key", key);
  headers.set("x-corvis-edge-proxy", "cloudflare-worker");
  headers.set("x-forwarded-host", env.PUBLIC_HOSTNAME);
  headers.set("x-forwarded-proto", "https");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return new Request(target.toString(), init);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== env.PUBLIC_HOSTNAME) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "TRACE" || request.method === "CONNECT") {
      return new Response("Method not allowed", { status: 405, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api" || (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/v1"))) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    const response = await fetch(gatewayTarget(request, env));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("x-corvis-edge-proxy", "cloudflare-worker");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
