import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { ProcessingStageDelivery } from "./orchestration-stage.ts";
import {
  executeProcessingWorkerRequest,
  parseProcessingStageDelivery,
  ProcessingWorkerRequestError,
  type ProcessingWorkerIngressDependencies,
} from "./processing-worker-ingress.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const eventId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const documentId = "22222222-2222-2222-2222-222222222222";
const workerUrl = "https://worker.example/api/internal/processing-stage";
const workerEmail = "corvis-worker-prod@example.iam.gserviceaccount.com";
const workerSubject = "109876543210987654321";

const delivery: ProcessingStageDelivery = {
  tenantId,
  consumerName: "processing-stage-worker",
  eventId,
  eventType: "DocumentRegistered",
  documentId,
  jobId: `registered:${documentId}`,
  expectedStage: "registered",
  payload: { artifactVersionId: "33333333-3333-3333-3333-333333333333", ingestionId: "ingestion-1" },
  payloadSha256: "a".repeat(64),
  maxAttempts: 5,
  leaseSeconds: 300,
};

const identity: RequestIdentity = {
  subject: workerSubject,
  tenantId,
  workspaceId: "workspace-a",
  roles: ["api_client"],
  entitlements: {
    workspaceIds: ["workspace-a"],
    documentIds: [documentId],
    sourceDocumentIds: [documentId],
    sourceDocumentAccessAllowed: true,
  },
  authMethod: "service_account",
  sessionId: "processing-worker:session",
};

function dependencies(overrides: Partial<ProcessingWorkerIngressDependencies> = {}): ProcessingWorkerIngressDependencies {
  return {
    config: { workerUrl, serviceAccountEmail: workerEmail },
    verifyGoogleIdentity: async (input) => {
      assert.equal(input.authorization, "Bearer google-token");
      assert.equal(input.audience, workerUrl);
      assert.equal(input.serviceAccountEmail, workerEmail);
      return { subject: workerSubject, email: workerEmail };
    },
    resolveIdentity: async (input) => {
      assert.deepEqual(input, { tenantId, subject: workerSubject, documentId });
      return identity;
    },
    stages: {
      claim: async () => ({
        claimed: true,
        duplicateComplete: false,
        leaseToken: "44444444-4444-4444-4444-444444444444",
        attempt: 1,
        inboxState: "processing",
        jobVersion: 2,
        jobState: "running",
      }),
      complete: async () => ({ completed: true, completedJobVersion: 3 }),
      fail: async () => undefined,
    },
    effects: {
      begin: async () => ({ shouldExecute: true, alreadyComplete: false, attempt: 1 }),
      complete: async () => true,
    },
    handler: {
      execute: async (input) => {
        assert.equal(input.stage, "registered");
        assert.equal(input.documentId, documentId);
        return { validated: true };
      },
    },
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request(workerUrl, {
    method: "POST",
    headers: { authorization: "Bearer google-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Cloud Tasks direct delivery reaches the existing stage/effect worker composition", async () => {
  const result = await executeProcessingWorkerRequest(request(delivery), dependencies());
  assert.deepEqual(result, { outcome: "completed", nextJobId: undefined, nextStage: undefined });
});

test("Pub/Sub push envelope decodes the same bounded delivery contract", async () => {
  const envelope = {
    message: {
      data: Buffer.from(JSON.stringify(delivery)).toString("base64"),
      attributes: { tenantId, eventType: delivery.eventType },
    },
    subscription: "projects/example/subscriptions/processing",
  };
  const parsed = await parseProcessingStageDelivery(request(envelope));
  assert.deepEqual(parsed, delivery);
});

test("Pub/Sub envelope attribute mismatch fails before stage claim", async () => {
  const envelope = {
    message: {
      data: Buffer.from(JSON.stringify(delivery)).toString("base64"),
      attributes: { tenantId: "99999999-9999-9999-9999-999999999999", eventType: delivery.eventType },
    },
  };
  await assert.rejects(() => parseProcessingStageDelivery(request(envelope)), (error: unknown) => {
    assert.ok(error instanceof ProcessingWorkerRequestError);
    assert.equal(error.status, 400);
    return true;
  });
});

test("unapproved Google identity and missing document authorization fail closed", async () => {
  let claimed = false;
  const stages = {
    ...dependencies().stages,
    claim: async (input: ProcessingStageDelivery) => {
      claimed = true;
      return dependencies().stages.claim(input);
    },
  };
  await assert.rejects(() => executeProcessingWorkerRequest(request(delivery), dependencies({
    stages,
    verifyGoogleIdentity: async () => { throw new Error("wrong audience"); },
  })), (error: unknown) => {
    assert.ok(error instanceof ProcessingWorkerRequestError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(claimed, false);

  await assert.rejects(() => executeProcessingWorkerRequest(request(delivery), dependencies({
    stages,
    resolveIdentity: async () => undefined,
  })), (error: unknown) => {
    assert.ok(error instanceof ProcessingWorkerRequestError);
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(claimed, false);
});

test("a busy durable claim remains retryable to Pub/Sub or Cloud Tasks", async () => {
  const result = await executeProcessingWorkerRequest(request(delivery), dependencies({
    stages: {
      ...dependencies().stages,
      claim: async () => ({
        claimed: false,
        duplicateComplete: false,
        attempt: 1,
        inboxState: "processing",
        jobVersion: 2,
        jobState: "running",
      }),
    },
  }));
  assert.deepEqual(result, { outcome: "busy", state: "running" });
});
