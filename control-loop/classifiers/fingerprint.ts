import { createHash } from "node:crypto";
import type { Finding, RuleDefinition } from "../types.ts";

/**
 * A fingerprint is `domain:owners:subject`. The subject segment is
 * `<slug>#<hash>`: the slug keeps it readable, and the hash (of the raw,
 * unslugged subject) keeps distinct subjects distinct. Slugging alone
 * collapses `docs/a-b.md` and `docs/a_b.md`, or two paths differing only in
 * case, into one fingerprint, and `dedupeFindings` then silently drops one.
 *
 * The first version of the format had no `#hash` ("legacy"). Stripping the hash
 * from a current fingerprint yields its legacy form, which is how issues opened
 * before the change are adopted instead of being closed and re-opened.
 */
export const SUBJECT_HASH_LENGTH = 10;
const SUBJECT_HASH = new RegExp(`^[0-9a-f]{${SUBJECT_HASH_LENGTH}}$`);

/** The line in a tracked issue body that carries its fingerprint. */
export const FINGERPRINT_LINE = /Finding fingerprint:\s*`([^`]+)`/;

export interface FingerprintParts {
  domain: string;
  owners: string[];
  /** The raw subject when formatting; the slug part when returned from `parseFingerprint`. */
  subject: string;
  /** Present on a current-format fingerprint. When given, it is used instead of hashing `subject`. */
  subjectHash?: string;
}

export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subjectHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, SUBJECT_HASH_LENGTH);
}

function prefix(parts: FingerprintParts): { domain: string; owners: string } {
  const domain = slug(parts.domain);
  const owners = parts.owners.map(slug).filter((value) => value.length > 0).join("-");
  if (!domain || !owners) throw new Error("fingerprint_requires_domain_owners_subject");
  return { domain, owners };
}

export function formatFingerprint(parts: FingerprintParts): string {
  const { domain, owners } = prefix(parts);
  const hash = parts.subjectHash ?? (parts.subject ? subjectHash(parts.subject) : "");
  if (!hash || !SUBJECT_HASH.test(hash)) throw new Error("fingerprint_requires_domain_owners_subject");
  return `${domain}:${owners}:${slug(parts.subject)}#${hash}`;
}

/** The pre-hash format, kept so existing fingerprints can still be parsed and matched. */
export function formatLegacyFingerprint(parts: FingerprintParts): string {
  const { domain, owners } = prefix(parts);
  const subject = slug(parts.subject);
  if (!subject) throw new Error("fingerprint_requires_domain_owners_subject");
  return `${domain}:${owners}:${subject}`;
}

/** The legacy form of a fingerprint; a fingerprint that is already legacy is returned unchanged. */
export function legacyFingerprintOf(value: string): string {
  const segments = value.split(":");
  if (segments.length !== 3) return value;
  const hashAt = segments[2]!.lastIndexOf("#");
  if (hashAt < 0) return value;
  return `${segments[0]}:${segments[1]}:${segments[2]!.slice(0, hashAt)}`;
}

export function parseFingerprint(value: string): FingerprintParts | null {
  const segments = value.split(":");
  if (segments.length !== 3) return null;
  const [domain, owners, tail] = segments;
  if (!domain || !owners || !tail) return null;
  const hashAt = tail.lastIndexOf("#");
  if (hashAt >= 0) {
    const subject = tail.slice(0, hashAt);
    const hash = tail.slice(hashAt + 1);
    if (!SUBJECT_HASH.test(hash)) return null;
    const parts: FingerprintParts = { domain, owners: owners.split("-"), subject, subjectHash: hash };
    try {
      if (formatFingerprint(parts) !== value) return null;
    } catch {
      return null;
    }
    return parts;
  }
  try {
    if (formatLegacyFingerprint({ domain, owners: [owners], subject: tail }) !== value) return null;
  } catch {
    return null;
  }
  return { domain, owners: owners.split("-"), subject: tail };
}

export function fingerprintFor(rule: RuleDefinition, subject: string): string {
  return formatFingerprint({ domain: rule.domain, owners: rule.owners, subject });
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique: Finding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.fingerprint)) continue;
    seen.add(finding.fingerprint);
    unique.push(finding);
  }
  return unique;
}

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = severityOrder[left.severity] - severityOrder[right.severity];
    if (bySeverity !== 0) return bySeverity;
    if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1;
    if (left.fingerprint === right.fingerprint) return 0;
    return left.fingerprint < right.fingerprint ? -1 : 1;
  });
}
