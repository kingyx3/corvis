export type Severity = "critical" | "high" | "medium" | "low";
export type Authority = "confluence" | "github";
export type RemediationClass = "auto-fix" | "human-approval";
export type RunMode = "daily" | "weekly" | "monthly" | "manual";
export type RunStatus = "complete" | "incomplete" | "failed";

export interface RuleDefinition {
  id: string;
  title: string;
  domain: string;
  owners: string[];
  severity: Severity;
  authority: Authority;
  remediation: RemediationClass;
  allowlist: string[];
  modes: RunMode[];
}

export interface TextEdit {
  path: string;
  before: string;
  after: string;
}

export interface Finding {
  ruleId: string;
  fingerprint: string;
  subject: string;
  severity: Severity;
  authority: Authority;
  remediation: RemediationClass;
  path: string | null;
  line: number | null;
  detail: string;
  suggestion: TextEdit | null;
}

export type ActionApproval = "automatic" | "human";
export type ActionDisposition = "planned" | "blocked";

export interface PlannedAction {
  ruleId: string;
  fingerprint: string;
  approval: ActionApproval;
  disposition: ActionDisposition;
  blockedReason: string | null;
  edit: TextEdit | null;
}

export type ApplyOutcome = "dry-run" | "applied" | "skipped";

export interface AppliedAction {
  fingerprint: string;
  outcome: ApplyOutcome;
  reason: string | null;
}

export interface ApplyResult {
  executed: boolean;
  dryRun: boolean;
  budget: number;
  budgetExceeded: boolean;
  blockedReason: string | null;
  actions: AppliedAction[];
}

export interface Watermark {
  schemaVersion: 1;
  lastSuccessfulDailyRunAt: string | null;
  lastSuccessfulWeeklyRunAt: string | null;
  lastWeeklyScanComplete: boolean;
  consecutiveFailures: number;
  lastRunId: string | null;
}

export interface HealthState {
  healthy: boolean;
  reasons: string[];
  automaticClosureEnabled: boolean;
}

export interface ScannerStatus {
  name: string;
  complete: boolean;
  /** True when the scanner was intentionally not run (unconfigured), as opposed to failing. */
  skipped?: boolean;
  reason: string | null;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  mode: RunMode;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  skipped: boolean;
  notes: string[];
  scan: {
    full: boolean;
    reason: string;
    filesScanned: number;
    scanners: ScannerStatus[];
  };
  findings: Finding[];
  plan: PlannedAction[];
  applied: ApplyResult | null;
  health: HealthState;
  closure: { allowed: boolean; reason: string | null };
  watermark: Watermark;
}
