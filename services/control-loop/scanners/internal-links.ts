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

/**
 * Link targets are arbitrary author text: a literal `%` (`growth-100%.md`) is a
 * malformed escape and makes `decodeURIComponent` throw, which would fail the
 * whole scan on every run. Fall back to the raw path, which is also how such a
 * file would actually be named on disk.
 */
function safeDecode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
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
    const fileFindings: Finding[] = [];
    const edits: Array<{ line: number; start: number; end: number; target: string }> = [];
    for (const link of markdownLinks(file.text)) {
      if (EXTERNAL_TARGET.test(link.target)) continue;
      const withoutAnchor = link.target.split("#")[0]!;
      const decoded = safeDecode(withoutAnchor);
      const resolved = decoded.startsWith("/") ? decoded.replace(/^\/+/, "") : resolveRelative(file.path, decoded);
      if (resolved && snapshot.paths.has(resolved)) continue;
      const subject = `${file.path}:broken-link:${decoded}`;
      const replacement = uniqueTargetFor(basenameOf(decoded), snapshot);
      const anchor = link.target.slice(withoutAnchor.length);
      const suggestion = replacement
        ? { path: file.path, before: file.text, after: "" }
        : null;
      if (replacement) {
        const target = relativePathBetween(file.path, replacement).split("/").map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29")).join("/") + anchor;
        edits.push({ line: link.line, start: link.start, end: link.end, target });
      }
      fileFindings.push({
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
    // Every finding in one document shares a single optimistic whole-file edit.
    // Replace only parsed link destinations, from right to left; prose/code stay intact.
    const lines = file.text.split("\n");
    for (const edit of edits.sort((a, b) => b.line - a.line || b.start - a.start)) {
      const line = lines[edit.line - 1]!;
      lines[edit.line - 1] = line.slice(0, edit.start) + edit.target + line.slice(edit.end);
    }
    const after = lines.join("\n");
    for (const finding of fileFindings) {
      if (finding.suggestion) finding.suggestion.after = after;
      findings.push(finding);
    }
  }
  return findings;
}
