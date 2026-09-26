export type ContentSecurityPolicyOptions = {
  /** Per-request nonce; Next.js parses it from the CSP header to authorize framework/page scripts. */
  nonce: string;
  isDev: boolean;
};

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
export function buildContentSecurityPolicy({ nonce, isDev }: ContentSecurityPolicyOptions): string {
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
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
