import { correlationId, json } from "@/platform/http/http";
import {
  BudgetGuardRequestError,
  executeConfiguredBudgetGuardRequest,
} from "@/platform/gcp/gcp-cost-guard";
import { logEvent } from "@/platform/telemetry";

export async function POST(request: Request): Promise<Response> {
  const id = correlationId(request);
  try {
    const result = await executeConfiguredBudgetGuardRequest(request);
    if (result.outcome === "hibernated") {
      logEvent("warn", "cost_guard.uat_hibernated", { correlationId: id }, {
        ratio: result.ratio,
        actions: result.actions?.map(({ kind, name, outcome }) => ({ kind, name, outcome })),
      });
    } else {
      logEvent("info", "cost_guard.budget_update", { correlationId: id }, {
        outcome: result.outcome,
        ratio: result.ratio,
        reason: result.reason,
      });
    }
    return json({ data: result, correlationId: id });
  } catch (error) {
    if (error instanceof BudgetGuardRequestError) {
      logEvent("warn", "cost_guard.rejected", { correlationId: id }, { code: error.code, status: error.status });
      return json({ error: error.code, correlationId: id }, { status: error.status });
    }
    logEvent("error", "cost_guard.failed", { correlationId: id }, {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    // A 5xx makes Pub/Sub retry; transient GCP control-plane failures must not
    // silently acknowledge a budget notification that should have hibernated UAT.
    return json({ error: "budget_guard_failed", correlationId: id }, { status: 500 });
  }
}
