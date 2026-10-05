import { createHash } from "node:crypto";
import type { Finding, RuleDefinition } from "../types.ts";

/**
 * A fingerprint is `domain:owners:subject`. The subject segment is
 * `<slug>#<hash>`: the slug keeps it readable, and the hash (of the raw,
 * unslugged subject) keeps distinct subjects distinct. Slugging alone collapses
 * `docs/a-b.md` and `docs/a_b.md`, or two paths differing only in case, into one
 * fingerprint, and `dedupeFindings` would then silently drop one of them.
 */
export const SUBJECT_HASH_LENGTH = 10;
const SUBJECT_HASH = new RegExp(`^[0-9a-f]{${SUBJECT_HASH_LENGTH}}$`);

export interface FingerprintParts {
  domain: string;
  owners: string[];
  /** The raw subject when formatting; the slug part when returned from `parseFingerprint`. */
  subject: string;
  /** Set by `parseFingerprint`. When given, it is used instead of hashing `subject`. */
  subjectHash?: string;
}

export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatFingerprint(parts: FingerprintParts): string {
  const domain = slug(parts.domain);
  const owners = parts.owners.map(slug).filter((value) => value.length > 0).join("-");
  const hash = parts.subjectHash ?? (parts.subject ? createHash("sha256").update(parts.subject).digest("hex").slice(0, SUBJECT_HASH_LENGTH) : "");
  if (!domain || !owners || !SUBJECT_HASH.test(hash)) throw new Error("fingerprint_requires_domain_owners_subject");
  return `${domain}:${owners}:${slug(parts.subject)}#${hash}`;
}

export function parseFingerprint(value: string): FingerprintParts | null {
  const segments = value.split(":");
  if (segments.length !== 3) return null;
  const [domain, owners, tail] = segments;
  if (!domain || !owners || !tail) return null;
  const hashAt = tail.lastIndexOf("#");
  if (hashAt < 0) return null;
  const parts: FingerprintParts = { domain, owners: owners.split("-"), subject: tail.slice(0, hashAt), subjectHash: tail.slice(hashAt + 1) };
  try {
    return formatFingerprint(parts) === value ? parts : null;
  } catch {
    return null;
  }
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
