/**
 * What a verified OpenID Connect token says about HOW the person signed in (F7a, #334).
 *
 * Corvis does not run the sign-in, so it knows only what the identity provider put in the token it signed: the standard
 * `amr` (authentication methods references, RFC 8176) and `acr` (authentication context class) claims. Both are optional,
 * and an identity provider that omits them has told Corvis nothing; the displays built on this therefore say "not reported"
 * rather than guessing. The claim values come from a verified token but are still bounded here, so an identity provider
 * (or a misconfiguration) can never push an unbounded or control-character value into a record, a log or a page.
 */

/** Most `amr` entries kept; further entries are ignored. */
export const MAX_AUTH_METHOD_ENTRIES = 20;
/** An `amr` entry is a short registered identifier (RFC 8176): lower-case letters, digits, `_`, `.` and `-`. */
const AUTH_METHOD_VALUE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** An `acr` value is an opaque identifier (often a URN or a level); printable, without whitespace, at most this long. */
export const MAX_AUTH_CONTEXT_LENGTH = 256;
const AUTH_CONTEXT_VALUE = /^[\x21-\x7e]+$/;

/** The registered `amr` values by factor category (RFC 8176 section 2). */
const KNOWLEDGE = new Set(["pwd", "pin", "kba"]);
const POSSESSION = new Set(["otp", "hwk", "swk", "sms", "tel", "sc"]);
const INHERENCE = new Set(["fpt", "face", "iris", "retina", "vbm"]);

/**
 * The `amr` entries of a token, validated and bounded: only an array is read (anything else is "not reported"), each entry
 * must be a short registered-style identifier (lower-cased; anything else is dropped), duplicates are removed and at most
 * {@link MAX_AUTH_METHOD_ENTRIES} are kept. A malformed claim never rejects the sign-in; it only reports less.
 */
export function boundedAuthMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const methods = new Set<string>();
  for (const entry of value.slice(0, MAX_AUTH_METHOD_ENTRIES)) {
    if (typeof entry !== "string") continue;
    const method = entry.trim().toLowerCase();
    if (AUTH_METHOD_VALUE.test(method)) methods.add(method);
  }
  return [...methods];
}

/** The `acr` claim when it is a bounded printable identifier; otherwise undefined (not reported). */
export function boundedAuthContext(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_AUTH_CONTEXT_LENGTH && AUTH_CONTEXT_VALUE.test(value) ? value : undefined;
}

/**
 * Whether the reported methods show more than one factor:
 *   null   no `amr` was reported, so nothing is known;
 *   true   `mfa` was reported, or factors from at least two different categories (knowledge, possession, inherence);
 *   false  an `amr` was reported without evidence of a second factor.
 * Deliberately conservative: a single possession factor (for example a hardware key on its own) is not counted as MFA
 * unless the provider also says `mfa`, because Corvis cannot tell whether the key was unlocked with a second factor.
 */
export function mfaEvidence(methods: readonly string[]): boolean | null {
  if (methods.length === 0) return null;
  if (methods.includes("mfa")) return true;
  const categories = [KNOWLEDGE, POSSESSION, INHERENCE].filter((category) => methods.some((method) => category.has(method)));
  return categories.length >= 2;
}

/** How a session's MFA evidence reads to an administrator; never more than the evidence shows. */
export function mfaEvidenceLabel(mfaUsed: boolean | null): string {
  if (mfaUsed === true) return "MFA used (reported by your identity provider)";
  if (mfaUsed === false) return "Your identity provider reported a sign-in without a second factor";
  return "Not reported by your identity provider";
}

/** What an operator recorded about the identity provider enforcing MFA: yes, no, or unknown (null). */
export function idpMfaEnforcementLabel(enforced: boolean | null): string {
  if (enforced === true) return "Yes (as recorded by Corvis support)";
  if (enforced === false) return "No (as recorded by Corvis support)";
  return "Not reported by your identity provider";
}
