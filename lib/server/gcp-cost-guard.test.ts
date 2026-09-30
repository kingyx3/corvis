import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetGuardRequestError,
  budgetGuardConfig,
  executeBudgetGuardRequest,
  type BudgetControlPort,
  type BudgetGuardConfig,
} from "./gcp-cost-guard.ts";

const config: BudgetGuardConfig = {
  projectId: "corvis-uat-123",
  region: "asia-southeast1",
  environment: "uat",
  budgetDisplayName: "corvis-uat-monthly-budget",
  guardThreshold: 0.85,
  audience: "https://corvis-budget-guard-uat.internal",
  serviceAccountEmail: "corvis-cost-guard-uat@corvis-uat-123.iam.gserviceaccount.com",
  processingQueueName: "processing-uat",
  schedulerJobNames: ["corvis-delivery-uat", "corvis-control-loop-daily-uat"],
};

function request(payload: Record<string, unknown>, displayName = config.budgetDisplayName): Request {
  const data = Buffer.from(JSON.stringify({
    budgetDisplayName: displayName,
    costAmount: 4.25,
    budgetAmount: 5,
    currencyCode: "USD",
    ...payload,
  })).toString("base64");
  return new Request("https://example.test/api/internal/budget-guard", {
    method: "POST",
    headers: { authorization: "Bearer signed", "content-type": "application/json" },
    body: JSON.stringify({ message: { data, attributes: { schemaVersion: "1.0" } } }),
  });
}

function dependencies(control: BudgetControlPort, verify = async () => ({ subject: "123", email: config.serviceAccountEmail })) {
  return { config, control, verifyGoogleIdentity: verify };
}

test("budget guard hibernates at the configured 85% threshold", async () => {
  let pauses = 0;
  const control: BudgetControlPort = {
    async pause() {
      pauses += 1;
      return [{ kind: "queue", name: "processing-uat", outcome: "paused" }];
    },
  };
  const result = await executeBudgetGuardRequest(request({}), dependencies(control));
  assert.equal(result.outcome, "hibernated");
  assert.equal(result.ratio, 0.85);
  assert.equal(pauses, 1);
});

test("budget guard acknowledges updates below the threshold without changing resources", async () => {
  let pauses = 0;
  const control: BudgetControlPort = { async pause() { pauses += 1; return []; } };
  const result = await executeBudgetGuardRequest(request({ costAmount: 4.24 }), dependencies(control));
  assert.equal(result.outcome, "below_threshold");
  assert.ok((result.ratio ?? 1) < 0.85);
  assert.equal(pauses, 0);
});

test("budget guard ignores a notification for another budget on the same topic", async () => {
  let pauses = 0;
  const control: BudgetControlPort = { async pause() { pauses += 1; return []; } };
  const result = await executeBudgetGuardRequest(request({}, "other-budget"), dependencies(control));
  assert.deepEqual(result, { outcome: "ignored", reason: "different_budget" });
  assert.equal(pauses, 0);
});

test("budget guard authenticates the Google push identity before parsing or acting", async () => {
  const control: BudgetControlPort = { async pause() { assert.fail("must not pause"); } };
  await assert.rejects(
    executeBudgetGuardRequest(request({}), dependencies(control, async () => { throw new Error("bad token"); })),
    (error: unknown) => error instanceof BudgetGuardRequestError
      && error.code === "budget_guard_authentication_failed"
      && error.status === 401,
  );
});

test("budget guard rejects malformed and non-USD notifications", async () => {
  const control: BudgetControlPort = { async pause() { assert.fail("must not pause"); } };
  await assert.rejects(
    executeBudgetGuardRequest(request({ budgetAmount: 0 }), dependencies(control)),
    (error: unknown) => error instanceof BudgetGuardRequestError && error.code === "invalid_budget_update",
  );
  await assert.rejects(
    executeBudgetGuardRequest(request({ currencyCode: "SGD" }), dependencies(control)),
    (error: unknown) => error instanceof BudgetGuardRequestError && error.code === "invalid_budget_update",
  );
});

test("budgetGuardConfig derives only the known low-cost UAT automation targets", () => {
  const actual = budgetGuardConfig({
    NODE_ENV: "test",
    CORVIS_ENVIRONMENT: "uat",
    CORVIS_GCP_PROJECT_ID: "corvis-uat-123",
    CORVIS_GCP_REGION: "asia-southeast1",
    CORVIS_BUDGET_DISPLAY_NAME: "corvis-uat-monthly-budget",
    CORVIS_BUDGET_GUARD_THRESHOLD: "0.85",
    CORVIS_BUDGET_GUARD_AUDIENCE: "https://corvis-budget-guard-uat.internal",
    CORVIS_BUDGET_GUARD_SERVICE_ACCOUNT: "corvis-cost-guard-uat@corvis-uat-123.iam.gserviceaccount.com",
  });
  assert.equal(actual.processingQueueName, "processing-uat");
  assert.deepEqual(actual.schedulerJobNames, [
    "corvis-delivery-uat",
    "corvis-control-loop-daily-uat",
    "corvis-control-loop-weekly-uat",
    "corvis-control-loop-monthly-uat",
  ]);
});