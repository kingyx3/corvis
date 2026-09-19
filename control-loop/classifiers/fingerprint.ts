import type { Finding, RuleDefinition } from "../types.ts";

export interface FingerprintParts {
  domain: string;
  owners: string[];
  subject: string;
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
  const subject = slug(parts.subject);
  if (!domain || !owners || !subject) throw new Error("fingerprint_requires_domain_owners_subject");
  return `${domain}:${owners}:${subject}`;
}

export function parseFingerprint(value: string): FingerprintParts | null {
  const segments = value.split(":");
  if (segments.length !== 3) return null;
  const [domain, owners, subject] = segments;
  if (!domain || !owners || !subject) return null;
  if (formatFingerprint({ domain, owners: [owners], subject }) !== value) return null;
  return { domain, owners: owners.split("-"), subject };
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
