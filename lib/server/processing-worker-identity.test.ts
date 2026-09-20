import assert from "node:assert/strict";
import test from "node:test";
import type { MembershipAuthorizationRepository } from "./authorization.ts";
import {
  processingWorkerSessionId,
  resolveProcessingWorkerIdentity,
  type ServiceIdentityWorkspaceRepository,
} from "./processing-worker-identity.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const documentId = "22222222-2222-2222-2222-222222222222";
const subject = "109876543210987654321";

function workspaceRepository(ids: string[]): ServiceIdentityWorkspaceRepository {
  return { listActiveWorkspaces: async () => ids };
}

function membershipRepository(entries: Record<string, string[]>): MembershipAuthorizationRepository {
  return {
    resolve: async (principal) => {
      const documentIds = entries[principal.workspaceId];
      if (!documentIds) return null;
      return {
        roles: ["api_client"],
        workspaceIds: [principal.workspaceId],
        fundIds: [],
        documentIds,
        sourceDocumentIds: documentIds,
        internalAnalyticsAllowed: false,
        modelTrainingAllowed: false,
        redistributionAllowed: false,
      };
    },
  };
}

test("worker identity is re-resolved through one authoritative document workspace", async () => {
  const identity = await resolveProcessingWorkerIdentity({
    tenantId,
    subject,
    documentId,
    workspaces: workspaceRepository(["workspace-a", "workspace-b"]),
    memberships: membershipRepository({
      "workspace-a": ["33333333-3333-3333-3333-333333333333"],
      "workspace-b": [documentId],
    }),
  });

  assert.equal(identity?.authMethod, "service_account");
  assert.equal(identity?.tenantId, tenantId);
  assert.equal(identity?.workspaceId, "workspace-b");
  assert.deepEqual(identity?.entitlements.documentIds, [documentId]);
  assert.equal(identity?.sessionId, processingWorkerSessionId(subject));
});

test("worker identity fails closed when document authorization is absent or ambiguous", async () => {
  const absent = await resolveProcessingWorkerIdentity({
    tenantId,
    subject,
    documentId,
    workspaces: workspaceRepository(["workspace-a"]),
    memberships: membershipRepository({ "workspace-a": [] }),
  });
  assert.equal(absent, undefined);

  const ambiguous = await resolveProcessingWorkerIdentity({
    tenantId,
    subject,
    documentId,
    workspaces: workspaceRepository(["workspace-a", "workspace-b"]),
    memberships: membershipRepository({ "workspace-a": [documentId], "workspace-b": [documentId] }),
  });
  assert.equal(ambiguous, undefined);
});
