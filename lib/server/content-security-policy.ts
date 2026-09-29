export type ContentSecurityPolicyOptions = {
  /** Per-request nonce; Next.js parses it from the CSP header to authorize framework/page scripts. */
  nonce: string;
  isDev: boolean;
  /**
   * Cross-origin Corvis API base (NEXT_PUBLIC_CORVIS_API_BASE). Defaults to that env var; when it is
   * a different origin than the page the browser must be allowed to call it. Same-origin (empty)
   * deployments need nothing here.
   */
  apiBase?: string;
};

/**
 * The only third-party host the browser talks to directly: GCS resumable upload sessions. The API
 * hands the browser the session URI GCS returned (lib/server/gcs.ts createResumableUpload posts to
 * https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o?uploadType=resumable), so chunk
 * PUTs and status queries (adapters/upload/http-gcs-resumable-upload.ts) go to this host only.
 */
export const GCS_UPLOAD_ORIGIN = "https://storage.googleapis.com";

/** Origin of a configured API base, or undefined when it is empty, relative or not http(s). */
export function apiOriginOf(apiBase: string | undefined): string | undefined {
  const value = apiBase?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function connectSrc({ isDev, apiBase }: Pick<ContentSecurityPolicyOptions, "isDev" | "apiBase">): string {
  const sources = ["'self'", GCS_UPLOAD_ORIGIN];
  const apiOrigin = apiOriginOf(apiBase ?? process.env.NEXT_PUBLIC_CORVIS_API_BASE);
  if (apiOrigin && !sources.includes(apiOrigin)) sources.push(apiOrigin);
  // Dev-only: the Next.js HMR socket.
  if (isDev) sources.push("ws://localhost:*", "ws://127.0.0.1:*");
  return `connect-src ${sources.join(" ")}`;
}

/**
 * Strict, nonce-based CSP for the App Router production output (Next.js 16.3.5 automatically
 * applies `nonce` to framework/runtime scripts, page bundles and RSC payload scripts once the
 * response's Content-Security-Policy header carries a `'nonce-...'` value and rendering is
 * dynamic). `'strict-dynamic'` lets those nonce'd scripts load their own subresources without
 * widening the origin allow-list; `'self'` remains for browsers that don't support it.
 *
 * `style-src` keeps `'unsafe-inline'`: React's `style` prop and inline `style="..."` attributes
 * cannot carry a nonce (nonces only apply to `<style>` elements/`<link rel=stylesheet>`), and the
 * codebase relies on inline style attributes (chart colors, computed widths). That's an accepted,
 * unrelated tradeoff — this policy only removes `'unsafe-inline'` from `script-src`.
 */
export function buildContentSecurityPolicy({ nonce, isDev, apiBase }: ContentSecurityPolicyOptions): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    connectSrc({ isDev, apiBase }),
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
