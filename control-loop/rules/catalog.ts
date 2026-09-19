import type { RuleDefinition, RunMode } from "../types.ts";

export const CONTROL_LOOP_DOMAIN = "business-control-loop";
export const CONTROL_LOOP_OWNERS = ["Strategy", "Engineering"];

const ALL_MODES: RunMode[] = ["daily", "weekly", "monthly", "manual"];
const DEEP_MODES: RunMode[] = ["weekly", "monthly", "manual"];

export const RULES: readonly RuleDefinition[] = [
  {
    id: "CL-DOC-001",
    title: "Business or control truth stated in GitHub without a Confluence link",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "high",
    authority: "confluence",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-DOC-002",
    title: "Technical implementation detail deferred to Confluence instead of GitHub",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "high",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-DOC-003",
    title: "Broken canonical internal documentation link",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "medium",
    authority: "github",
    remediation: "auto-fix",
    allowlist: ["docs/"],
    modes: ALL_MODES,
  },
  {
    id: "CL-ARCH-001",
    title: "Domain layer imports a provider adapter or server runtime module",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "critical",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-ARCH-002",
    title: "Feature code imports server or provider modules instead of typed ports",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "high",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-ISSUE-001",
    title: "Control-loop issue carries no parseable finding fingerprint",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "medium",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: DEEP_MODES,
  },
  {
    id: "CL-ISSUE-002",
    title: "Duplicate open control-loop issues share one finding fingerprint",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "high",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-ISSUE-003",
    title: "Closed control-loop issue whose finding recurred and must reopen",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "high",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
  {
    id: "CL-HEALTH-001",
    title: "Control-loop run health degraded",
    domain: CONTROL_LOOP_DOMAIN,
    owners: CONTROL_LOOP_OWNERS,
    severity: "critical",
    authority: "github",
    remediation: "human-approval",
    allowlist: [],
    modes: ALL_MODES,
  },
];

const byId = new Map(RULES.map((definition) => [definition.id, definition]));

export function rule(id: string): RuleDefinition {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown_control_loop_rule:${id}`);
  return found;
}

export function rulesForMode(mode: RunMode): RuleDefinition[] {
  return RULES.filter((definition) => definition.modes.includes(mode));
}

export function ruleEnabled(id: string, mode: RunMode): boolean {
  return rule(id).modes.includes(mode);
}
