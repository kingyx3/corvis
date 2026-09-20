const apiProxyWorker = {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    if (incoming.hostname !== env.PUBLIC_HOSTNAME || !incoming.pathname.startsWith("/api/v1")) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }

    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = "https:";
    upstreamUrl.hostname = env.GATEWAY_HOST;
    upstreamUrl.port = "";

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("x-api-key");
    headers.set("x-api-key", env.GATEWAY_API_KEY);
    headers.set("x-corvis-edge-proxy", "cloudflare-worker");

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

    const upstream = await fetch(new Request(upstreamUrl, init));

    const response = new Response(upstream.body, upstream);
    response.headers.set("x-corvis-edge-proxy", "cloudflare-worker");
    response.headers.set("cache-control", response.headers.get("cache-control") || "no-store");
    return response;
  },
};

export default apiProxyWorker;
