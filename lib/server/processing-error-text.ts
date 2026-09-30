/**
 * Safe, bounded error text for persisted `last_error` columns.
 *
 * Handler and provider errors can embed upstream response bodies, bearer
 * tokens, signed URLs or connection strings. Those columns are operator-visible
 * and long-lived, so what we store is a stable error class plus a redacted,
 * truncated message -- never the raw text.
 */

export const LAST_ERROR_MAX_CHARS = 500;

const REDACTED = "[redacted]";

const RULES: Array<[RegExp, string]> = [
  // Authorization material.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, `Basic ${REDACTED}`],
  // JWTs (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Credentials embedded in URLs, then any query string / fragment (signed URLs).
  // Userinfo runs to the last "@" of the token: passwords are routinely pasted into DSNs unencoded, with "/" or "@" in them.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]*@/gi, "$1"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1"],
  // Cookie headers carry session ids; drop the whole header value.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`],
  // Vendor token formats that are not caught by the generic opaque-token rule below (short, or all letters).
  [/\b(?:xox[abprs]|sk_live|rk_live|sk_test|pk_live|github_pat|glpat)[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
  // An embedded JSON object is an upstream response body: keep the prefix, drop the body.
  [/\{\s*["'][\s\S]*$/, "{body omitted}"],
  // key=value / "key": "value" pairs whose key names a secret.
  [/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|signature|x-goog-signature|private[_-]?key|credential)s?["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi, `$1${REDACTED}`],
];

// Long mixed letter+digit runs are almost always keys/tokens. UUIDs and pure hex digests are
// identifiers/evidence hashes that operators need, so they are kept.
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_+=-]*[A-Za-z])(?=[A-Za-z0-9_+=-]*\d)[A-Za-z0-9_+=-]{32,}\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGEST = /^[0-9a-f]{32,}$/i;

/** Redacts secrets from an arbitrary error string and bounds its length. */
export function redactErrorText(text: string, maxChars: number = LAST_ERROR_MAX_CHARS): string {
  let out = String(text ?? "");
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  out = out.replace(OPAQUE_TOKEN, (match) => (UUID.test(match) || HEX_DIGEST.test(match) ? match : REDACTED));
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

/** Stable, low-cardinality class for an error (never derived from message text). */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(error.name) ? error.name : "Error";
  }
  return "NonError";
}

/** `Class: redacted message`, bounded to `maxChars`. Use for every persisted `last_error`. */
export function safeErrorText(error: unknown, maxChars: number = LAST_ERROR_MAX_CHARS): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const prefix = `${errorClassOf(error)}: `;
  const body = redactErrorText(message, Math.max(0, maxChars - prefix.length));
  return body ? `${prefix}${body}` : prefix.trimEnd().replace(/:$/, "");
}
