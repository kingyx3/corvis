import { fingerprintFor } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding } from "../types.ts";
import { isDocumentationPath, markdownLinks, relativePathBetween, resolveRelative } from "./markdown.ts";
import type { RepoFile, RepoSnapshot } from "./repo-snapshot.ts";

const EXTERNAL_TARGET = /^([a-z][a-z0-9+.-]*:|\/\/|#|mailto:)/i;

function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function uniqueTargetFor(basename: string, snapshot: RepoSnapshot): string | null {
  let match: string | null = null;
  for (const candidate of snapshot.paths) {
    if (basenameOf(candidate) !== basename) continue;
    if (match) return null;
    match = candidate;
  }
  return match;
}

export function scanInternalLinks(files: RepoFile[], snapshot: RepoSnapshot): Finding[] {
  const findings: Finding[] = [];
  const broken = rule("CL-DOC-003");
  for (const file of files) {
    if (!isDocumentationPath(file.path)) continue;
    for (const link of markdownLinks(file.text)) {
      if (EXTERNAL_TARGET.test(link.target)) continue;
      const withoutAnchor = link.target.split("#")[0] ?? "";
      if (!withoutAnchor) continue;
      const decoded = decodeURIComponent(withoutAnchor);
      const resolved = decoded.startsWith("/") ? decoded.replace(/^\/+/, "") : resolveRelative(file.path, decoded);
      if (resolved && snapshot.paths.has(resolved)) continue;
      const subject = `${file.path}:broken-link:${decoded}`;
      const replacement = uniqueTargetFor(basenameOf(decoded), snapshot);
      const suggestion = replacement
        ? { path: file.path, before: link.target, after: relativePathBetween(file.path, replacement) }
        : null;
      findings.push({
        ruleId: broken.id,
        fingerprint: fingerprintFor(broken, subject),
        subject,
        severity: broken.severity,
        authority: broken.authority,
        remediation: suggestion ? broken.remediation : "human-approval",
        path: file.path,
        line: link.line,
        detail: `canonical internal link "${link.target}" does not resolve to a tracked repository path`,
        suggestion,
      });
    }
  }
  return findings;
}
