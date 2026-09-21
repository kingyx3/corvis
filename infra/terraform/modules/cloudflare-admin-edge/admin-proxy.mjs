function isPrivilegedApi(pathname) {
  if (pathname === "/api/v1/admin" || pathname.startsWith("/api/v1/admin/")) return true;
  if (pathname === "/api/v1/source-connections" || pathname.startsWith("/api/v1/source-connections/")) return true;
  return /^\/api\/v1\/jobs\/[^/]+\/(?:retry|recover)$/.test(pathname);
}

function upstreamRequest(request, host, key, publicHostname) {
  const target = new URL(request.url);
  target.protocol = "https:";
  target.hostname = host;
  target.port = "";

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-api-key");
  headers.set("x-api-key", key);
  headers.set("x-corvis-edge-proxy", "cloudflare-worker");
  headers.set("x-forwarded-host", publicHostname);
  headers.set("x-forwarded-proto", "https");

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return new Request(target.toString(), init);
}

const adminProxyWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== env.PUBLIC_HOSTNAME) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "TRACE" || request.method === "CONNECT") {
      return new Response("Method not allowed", { status: 405, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/") {
      return Response.redirect(`https://${env.PUBLIC_HOSTNAME}/admin`, 302);
    }

    const apiRequest = url.pathname.startsWith("/api/");
    if (apiRequest && !isPrivilegedApi(url.pathname)) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (!apiRequest && url.pathname !== "/admin" && !url.pathname.startsWith("/admin/") && !url.pathname.startsWith("/_next/") && url.pathname !== "/favicon.ico") {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    const host = apiRequest ? env.API_GATEWAY_HOST : env.ADMIN_GATEWAY_HOST;
    const key = apiRequest ? env.API_GATEWAY_API_KEY : env.ADMIN_GATEWAY_API_KEY;
    const upstream = await fetch(upstreamRequest(request, host, key, env.PUBLIC_HOSTNAME));
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-frame-options", "DENY");
    headers.set("x-corvis-edge-proxy", "cloudflare-worker");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};

export default adminProxyWorker;
