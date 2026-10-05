import { getServerConfig } from "@/platform/config/config";

/**
 * The in-product stand-in for a real provider's OAuth consent page, used only by the demo provider in demo mode
 * (production refuses `CORVIS_DEMO_MODE`; anywhere else this answers 404). It contacts nothing and is
 * labelled as a demonstration. It authenticates nobody, like a provider page, and grants nothing by itself: the
 * redirect it offers carries a one-time demo code that the app exchanges, with the PKCE verifier, only for a demo
 * credential. The redirect target must be this app's own origin, so the page is never an open redirect.
 */
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo provider sign-in</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1f24;background:#fff}a.button{display:inline-block;margin:.5rem .75rem .5rem 0;padding:.6rem 1rem;border:2px solid #1b1f24;border-radius:.4rem;color:#1b1f24;font-weight:600;text-decoration:none}a.primary{background:#1b1f24;color:#fff}.demo{border:2px dashed #6b4a00;padding:.75rem 1rem;background:#fff6dd;border-radius:.4rem}</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function GET(request: Request) {
  if (!getServerConfig().demoMode) return new Response("Not Found", { status: 404 });
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  let redirect: URL | undefined;
  try { redirect = new URL(url.searchParams.get("redirect_uri") ?? ""); } catch { redirect = undefined; }
  const appOrigin = getServerConfig().publicAppUrl ?? url.origin;
  if (!TOKEN.test(state) || !TOKEN.test(challenge) || !redirect || redirect.origin !== appOrigin) {
    return page("<h1>Demo provider sign-in</h1><p>This sign-in request is not valid.</p>", 400);
  }
  const approve = new URL(redirect);
  approve.searchParams.set("code", `demo-code.${challenge}`);
  approve.searchParams.set("state", state);
  const deny = new URL(redirect);
  deny.searchParams.set("error", "access_denied");
  deny.searchParams.set("state", state);
  return page(`<p class="demo"><strong>Demonstration only.</strong> This page stands in for a provider&apos;s consent screen. No real portal is contacted.</p>
<h1>Demo data room: approve access?</h1>
<p>Corvis is asking to read the demo data room folders you chose in Corvis. It cannot upload, change or delete anything.</p>
<p><a class="button primary" href="${escapeHtml(approve.toString())}">Approve access</a><a class="button" href="${escapeHtml(deny.toString())}">Deny access</a></p>`);
}
