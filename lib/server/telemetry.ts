import { getServerConfig } from "@/lib/server/config";

export type LogLevel = "info" | "warn" | "error";
export type TelemetryContext = { correlationId: string; tenantId?: string; workspaceId?: string; actorSubject?: string; jobId?: string; documentId?: string };

function forward(record: Record<string, unknown>): void {
  const config = getServerConfig();
  if (!config.observabilityEndpoint || config.demoMode) return;
  void fetch(config.observabilityEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.observabilityToken ? { authorization: `Bearer ${config.observabilityToken}` } : {}),
    },
    body: JSON.stringify(record),
    keepalive: true,
  }).catch(() => undefined);
}

export function logEvent(level: LogLevel, event: string, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  const record = { timestamp: new Date().toISOString(), level, service: "corvis-web", event, ...context, ...fields };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
  forward(record);
}

export function durationMetric(name: string, startedAtMs: number, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  durationValueMetric(name, Date.now() - startedAtMs, context, fields);
}

export function durationValueMetric(name: string, durationMs: number, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  logEvent("info", "metric.duration", context, { metric: name, durationMs: Math.max(0, durationMs), ...fields });
}

export function countMetric(name: string, value: number, context: TelemetryContext, fields: Record<string, unknown> = {}) {
  logEvent("info", "metric.count", context, { metric: name, value, ...fields });
}
