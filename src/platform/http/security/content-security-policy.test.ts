import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContentSecurityPolicy, generateNonce } from "./content-security-policy.ts";

function directive(csp: string, name: string): string | undefined {
  return csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
}

test("production script-src carries the request nonce and strict-dynamic with no unsafe-inline", () => {
  const csp = buildContentSecurityPolicy({ nonce: "abc123", isDev: false });
  const scriptSrc = directive(csp, "script-src");
  assert.ok(scriptSrc, "script-src directive must be present");
  assert.match(scriptSrc!, /'nonce-abc123'/);
  assert.match(scriptSrc!, /'strict-dynamic'/);
  assert.equal(scriptSrc!.includes("unsafe-inline"), false, "script-src must not fall back to unsafe-inline");
  assert.equal(scriptSrc!.includes("unsafe-eval"), false, "unsafe-eval is a development-only allowance");
});

test("development script-src keeps unsafe-eval for React's server-stack debugging", () => {
  const csp = buildContentSecurityPolicy({ nonce: "dev-nonce", isDev: true });
  const scriptSrc = directive(csp, "script-src");
  assert.match(scriptSrc!, /'nonce-dev-nonce'/);
  assert.match(scriptSrc!, /'unsafe-eval'/);
});

test("style-src keeps unsafe-inline because inline style attributes cannot carry a nonce", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", isDev: false });
  assert.equal(directive(csp, "style-src"), "style-src 'self' 'unsafe-inline'");
});

test("other directives are unchanged from the prior static policy", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", isDev: false });
  assert.equal(directive(csp, "default-src"), "default-src 'self'");
  assert.equal(directive(csp, "base-uri"), "base-uri 'self'");
  assert.equal(directive(csp, "frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "form-action"), "form-action 'self'");
  assert.equal(directive(csp, "img-src"), "img-src 'self' data: blob:");
  assert.equal(directive(csp, "font-src"), "font-src 'self' data:");
  assert.equal(directive(csp, "worker-src"), "worker-src 'self' blob:");
  assert.ok(csp.includes("upgrade-insecure-requests"));
});

test("connect-src is an allowlist: self plus the GCS upload host, never a blanket https:", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", isDev: false, apiBase: "" });
  assert.equal(directive(csp, "connect-src"), "connect-src 'self' https://storage.googleapis.com");
  assert.doesNotMatch(directive(csp, "connect-src")!, /(^|\s)(https?:|\*)(\s|$)/);
});

test("a cross-origin API base is allowed by origin only", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", isDev: false, apiBase: "https://api.corvis.example/prefix/" });
  assert.equal(directive(csp, "connect-src"), "connect-src 'self' https://storage.googleapis.com https://api.corvis.example");
  const junk = buildContentSecurityPolicy({ nonce: "n", isDev: false, apiBase: "javascript:alert(1)" });
  assert.equal(directive(junk, "connect-src"), "connect-src 'self' https://storage.googleapis.com");
});

test("development adds only the local HMR socket to connect-src", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", isDev: true, apiBase: "" });
  assert.equal(directive(csp, "connect-src"), "connect-src 'self' https://storage.googleapis.com ws://localhost:* ws://127.0.0.1:*");
});

test("generateNonce produces unique, non-empty values", () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});
