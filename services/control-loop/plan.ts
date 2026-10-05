import type { Finding, PlannedAction } from "./types.ts";
import { rule } from "./rules/catalog.ts";

/**
 * Phase one of the mandated two-phase execution: classify every finding into
 * a proposed action and persist it before anything is applied. A finding
 * only becomes an automatic, allowlisted action when its rule marks it
 * `auto-fix`, it carries a concrete edit, and that edit's path falls under
 * the rule's own allowlist; every other finding is blocked for human review,
 * never silently skipped.
 */
export function planActions(findings: readonly Finding[]): PlannedAction[] {
  return findings.map((finding) => {
    const definition = rule(finding.ruleId);
    if (definition.remediation !== "auto-fix") {
      return {
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        approval: "human",
        disposition: "blocked",
        blockedReason: "rule_requires_human_approval",
        edit: null,
      };
    }
    if (!finding.suggestion) {
      return {
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        approval: "human",
        disposition: "blocked",
        blockedReason: "no_deterministic_edit_available",
        edit: null,
      };
    }
    const allowed = definition.allowlist.some((prefix) => finding.suggestion!.path.startsWith(prefix));
    if (!allowed) {
      return {
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        approval: "human",
        disposition: "blocked",
        blockedReason: "edit_path_not_allowlisted",
        edit: null,
      };
    }
    return {
      ruleId: finding.ruleId,
      fingerprint: finding.fingerprint,
      approval: "automatic",
      disposition: "planned",
      blockedReason: null,
      edit: finding.suggestion,
    };
  });
}
