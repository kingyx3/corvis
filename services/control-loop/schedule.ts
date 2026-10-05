import type { RunMode } from "./types.ts";

export type RunModeInput = RunMode | "monthly-candidate";

const VALID_MODES: readonly RunMode[] = ["daily", "weekly", "monthly", "manual"];

function singaporeDayOfMonth(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    day: "numeric",
  }).formatToParts(now);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("singapore_day_resolution_failed");
  return day;
}

/** Resolve the scheduler-only monthly candidate into the existing RunMode contract. */
export function resolveRunMode(value: string | undefined, now = new Date()): RunMode {
  if (value === "monthly-candidate") return singaporeDayOfMonth(now) <= 7 ? "monthly" : "weekly";
  if (!value || !VALID_MODES.includes(value as RunMode)) {
    throw new Error(`--mode must be one of ${[...VALID_MODES, "monthly-candidate"].join(", ")}`);
  }
  return value as RunMode;
}
