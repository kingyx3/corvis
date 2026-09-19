import { fingerprintFor } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding } from "../types.ts";
import { isDocumentationPath, proseLines } from "./markdown.ts";
import type { RepoFile } from "./repo-snapshot.ts";

export const BUSINESS_AUTHORITY_PHRASES = [
  "business architecture",
  "certification status",
  "commercial terms",
  "compliance claim",
  "contractual commitment",
  "control owner",
  "customer commitment",
  "data residency decision",
  "legal basis",
  "operating standard",
  "pricing",
  "product scope",
  "readiness decision",
  "readiness gate",
  "risk acceptance",
  "risk register",
  "vendor decision",
];

export const TECHNICAL_DETAIL_TERMS = [
  "ci/cd",
  "deployment",
  "environment variable",
  "iac",
  "migration",
  "pipeline",
  "runbook",
  "schema",
  "secret",
  "service account",
  "sql",
  "terraform",
  "workflow",
];

const DEFERRAL_PHRASES = ["see confluence", "refer to confluence", "documented in confluence", "maintained in confluence", "tracked in confluence", "lives in confluence", "source of truth"];

const CONFLUENCE_REFERENCE = /(confluence|atlassian\.net\/wiki)/i;
const GITHUB_OWNERSHIP = /github (owns|is the)/i;

function containsAny(haystack: string, needles: string[]): string | null {
  for (const needle of needles) {
    if (haystack.includes(needle)) return needle;
  }
  return null;
}

export function scanDocumentationAuthority(files: RepoFile[]): Finding[] {
  const findings: Finding[] = [];
  const unlinked = rule("CL-DOC-001");
  const deferred = rule("CL-DOC-002");
  for (const file of files) {
    if (!isDocumentationPath(file.path)) continue;
    const lines = proseLines(file.text);
    const linksConfluence = CONFLUENCE_REFERENCE.test(file.text);
    if (!linksConfluence) {
      for (const line of lines) {
        const phrase = containsAny(line.text.toLowerCase(), BUSINESS_AUTHORITY_PHRASES);
        if (!phrase) continue;
        findings.push({
          ruleId: unlinked.id,
          fingerprint: fingerprintFor(unlinked, `${file.path}:business-truth-unlinked`),
          subject: `${file.path}:business-truth-unlinked`,
          severity: unlinked.severity,
          authority: unlinked.authority,
          remediation: unlinked.remediation,
          path: file.path,
          line: line.number,
          detail: `states Confluence-owned business or control truth ("${phrase}") without linking the canonical Confluence page`,
          suggestion: null,
        });
        break;
      }
    }
    for (const line of lines) {
      const lowered = line.text.toLowerCase();
      if (!CONFLUENCE_REFERENCE.test(lowered)) continue;
      if (GITHUB_OWNERSHIP.test(lowered)) continue;
      if (!containsAny(lowered, DEFERRAL_PHRASES)) continue;
      const term = containsAny(lowered, TECHNICAL_DETAIL_TERMS);
      if (!term) continue;
      findings.push({
        ruleId: deferred.id,
        fingerprint: fingerprintFor(deferred, `${file.path}:technical-detail-deferred`),
        subject: `${file.path}:technical-detail-deferred`,
        severity: deferred.severity,
        authority: deferred.authority,
        remediation: deferred.remediation,
        path: file.path,
        line: line.number,
        detail: `defers GitHub-owned technical detail ("${term}") to Confluence; move the detail into GitHub and link it from Confluence instead`,
        suggestion: null,
      });
      break;
    }
  }
  return findings;
}
