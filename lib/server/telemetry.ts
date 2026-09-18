export type LogLevel = "info" | "warn" | "error";
export type TelemetryContext = { correlationId: string; tenantId?: string; workspaceId?: string; actorSubject?: string; jobId?: string; documentId?: string };

export function logEvent(level: LogLevel, event: string, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  const record = { timestamp: new Date().toISOString(), level, service: "corvis-web", event, ...context, ...fields };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function durationMetric(name: string, startedAtMs: number, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  logEvent("info", "metric.duration", context, { metric: name, durationMs: Math.max(0, Date.now() - startedAtMs), ...fields });
}

export function countMetric(name: string, value: number, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  logEvent("info", "metric.count", context, { metric: name, value, ...fields });
}
