import { fingerprintFor } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding } from "../types.ts";
import { resolveRelative } from "./markdown.ts";
import type { RepoFile } from "./repo-snapshot.ts";

export interface ModuleBoundary {
  ruleId: string;
  from: string;
  forbidden: string[];
  expectation: string;
}

export const MODULE_BOUNDARIES: readonly ModuleBoundary[] = [
  {
    ruleId: "CL-ARCH-001",
    from: "core/",
    forbidden: ["adapters/", "runtime/", "lib/server/"],
    expectation: "domain contracts in core/ must not import provider adapters or server runtime",
  },
  {
    ruleId: "CL-ARCH-002",
    from: "features/",
    forbidden: ["lib/server/", "adapters/"],
    expectation: "feature code must depend on typed ports and runtime composition, not server or provider modules",
  },
];

const IMPORT_SPECIFIER = /(?:from|import|require\()\s*["']([^"']+)["']/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function isScannableSource(path: string): boolean {
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) return resolveRelative(fromPath, specifier);
  return null;
}

export function scanArchitectureDrift(files: RepoFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isScannableSource(file.path)) continue;
    for (const boundary of MODULE_BOUNDARIES) {
      if (!file.path.startsWith(boundary.from)) continue;
      const definition = rule(boundary.ruleId);
      const violated = new Set<string>();
      for (const specifier of importSpecifiers(file.text)) {
        const resolved = resolveSpecifier(file.path, specifier);
        if (!resolved) continue;
        const forbidden = boundary.forbidden.find((prefix) => resolved.startsWith(prefix));
        if (forbidden) violated.add(forbidden);
      }
      for (const forbidden of [...violated].sort()) {
        const subject = `${file.path}:imports:${forbidden}`;
        findings.push({
          ruleId: definition.id,
          fingerprint: fingerprintFor(definition, subject),
          subject,
          severity: definition.severity,
          authority: definition.authority,
          remediation: definition.remediation,
          path: file.path,
          line: null,
          detail: `${boundary.expectation}; found an import of ${forbidden}`,
          suggestion: null,
        });
      }
    }
  }
  return findings;
}
