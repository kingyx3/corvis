import { fingerprintFor } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding } from "../types.ts";
import { resolveRelative } from "./markdown.ts";
import type { RepoFile } from "./repo-snapshot.ts";

export interface ModuleBoundary {
  ruleId: string;
  /** Path prefixes the rule governs. `*` stands for one path segment (for example `src/modules/*\/domain/`). */
  from: string[];
  /** Path prefixes the governed code must not import, in the same notation. */
  forbidden: string[];
  expectation: string;
}

/**
 * Layering inside `src/modules/<module>/`:
 *   domain/   pure contracts and rules
 *   server/   use cases, repositories and HTTP helpers that run on the server
 *   adapters/ provider- or demo-specific implementations of domain ports
 *   ui/       React views and client state
 * `src/shared/domain/` is the shared kernel; `src/platform/` is cross-cutting server infrastructure and
 * `src/composition/` wires ports to adapters.
 */
export const MODULE_BOUNDARIES: readonly ModuleBoundary[] = [
  {
    ruleId: "CL-ARCH-001",
    from: ["src/modules/*/domain/", "src/shared/domain/"],
    forbidden: ["src/modules/*/adapters/", "src/modules/*/server/", "src/modules/*/ui/", "src/platform/", "src/composition/"],
    expectation: "domain contracts must not import provider adapters, server runtime, UI or composition code",
  },
  {
    ruleId: "CL-ARCH-002",
    from: ["src/modules/*/ui/", "src/shared/ui/"],
    forbidden: ["src/modules/*/server/", "src/modules/*/adapters/", "src/platform/"],
    expectation: "UI code must depend on typed ports and runtime composition, not server or provider modules",
  },
];

const patternCache = new Map<string, RegExp>();

/** True when `path` starts with `prefix`, where `*` in the prefix matches exactly one path segment. */
export function matchesPrefix(path: string, prefix: string): boolean {
  let pattern = patternCache.get(prefix);
  if (!pattern) {
    pattern = new RegExp(`^${prefix.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}`);
    patternCache.set(prefix, pattern);
  }
  return pattern.test(path);
}

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
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith(".")) return resolveRelative(fromPath, specifier);
  return null;
}

export function scanArchitectureDrift(files: RepoFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isScannableSource(file.path)) continue;
    for (const boundary of MODULE_BOUNDARIES) {
      if (!boundary.from.some((prefix) => matchesPrefix(file.path, prefix))) continue;
      const definition = rule(boundary.ruleId);
      const violated = new Set<string>();
      for (const specifier of importSpecifiers(file.text)) {
        const resolved = resolveSpecifier(file.path, specifier);
        if (!resolved) continue;
        const forbidden = boundary.forbidden.find((prefix) => matchesPrefix(resolved, prefix));
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
