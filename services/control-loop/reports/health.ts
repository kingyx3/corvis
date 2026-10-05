import { fingerprintFor } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding, HealthState, RunStatus, Watermark } from "../types.ts";

export const DAILY_STALENESS_LIMIT_MS = 36 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 2;
export const CONTROL_LOOP_HEALTH_SUBJECT = "continuous-governance";

export interface HealthInput {
  now: Date;
  watermark: Watermark;
  weeklyScanComplete: boolean;
}

export function evaluateHealth(input: HealthInput): HealthState {
  const reasons: string[] = [];
  const last = input.watermark.lastSuccessfulDailyRunAt ? Date.parse(input.watermark.lastSuccessfulDailyRunAt) : Number.NaN;
  if (!Number.isFinite(last) || input.now.getTime() - last > DAILY_STALENESS_LIMIT_MS) reasons.push("no_successful_daily_run_in_36h");
  if (input.watermark.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) reasons.push("two_consecutive_failures");
  if (!input.weeklyScanComplete) reasons.push("incomplete_weekly_scan");
  return { healthy: reasons.length === 0, reasons, automaticClosureEnabled: reasons.length === 0 };
}

export function healthFinding(health: HealthState): Finding | null {
  if (health.healthy) return null;
  const definition = rule("CL-HEALTH-001");
  return {
    ruleId: definition.id,
    fingerprint: fingerprintFor(definition, CONTROL_LOOP_HEALTH_SUBJECT),
    subject: CONTROL_LOOP_HEALTH_SUBJECT,
    severity: definition.severity,
    authority: definition.authority,
    remediation: definition.remediation,
    path: null,
    line: null,
    detail: `control loop is unhealthy (${health.reasons.join(", ")}); automatic issue closure is disabled until a successful validating run`,
    suggestion: null,
  };
}

export interface ClosureDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Automatic closure needs a full scan: an incremental daily scan only produces
 * active fingerprints for changed files, so every open issue about an
 * unchanged file would otherwise look resolved.
 */
export function closureDecision(input: { status: RunStatus; health: HealthState; scanComplete: boolean; fullScan: boolean }): ClosureDecision {
  if (input.status !== "complete") return { allowed: false, reason: `run_status_${input.status}` };
  if (!input.scanComplete) return { allowed: false, reason: "incomplete_scan" };
  if (!input.fullScan) return { allowed: false, reason: "incremental_scan" };
  if (!input.health.automaticClosureEnabled) return { allowed: false, reason: `unhealthy:${input.health.reasons.join(",")}` };
  return { allowed: true, reason: null };
}
