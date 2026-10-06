import assert from "node:assert/strict";
import test from "node:test";
import { documents, fundSnapshots, observations } from "../demo/catalog.ts";
import type { RequestIdentity } from "../../shared/domain/enterprise.ts";
import { platform, PostgresProductionPlatform } from "./platform.ts";

process.env.CORVIS_DEMO_MODE = "true";

const identity: RequestIdentity = {
  subject: "demo|reviewer",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  entitlements: { workspaceIds: ["00000000-0000-0000-0000-000000000020"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

test("platform() selects the in-memory demo platform in demo mode and memoises it", () => {
  const selected = platform();
  assert.equal(selected instanceof PostgresProductionPlatform, false);
  assert.equal(platform(), selected);
});

test("the demo platform serves the demo catalog and has no reconciliation exceptions or jobs", async () => {
  const demo = platform();
  assert.equal(await demo.listDocuments(identity), documents);
  assert.equal(await demo.listObservations(identity), observations);
  assert.equal(await demo.listSnapshots(identity), fundSnapshots);
  assert.deepEqual(await demo.listReconciliationExceptions(identity, "snapshot", 1), []);
  assert.deepEqual(await demo.jobs(identity), []);
  assert.ok(Array.isArray(await demo.portfolioValueFacts(identity)));
  assert.ok(Array.isArray(await demo.exposureDimensionFacts(identity)));
});

test("demo review, resolution and publication accept the command and bump the version", async () => {
  const demo = platform();
  const base = { observationId: "o1", reasonCode: "ok", expectedVersion: 4 };
  const approved = await demo.review(identity, { ...base, decision: "approve" });
  const rejected = await demo.review(identity, { ...base, decision: "reject" });
  const corrected = await demo.review(identity, { ...base, decision: "correct", correctedValue: "1" });
  assert.deepEqual([approved.newVersion, approved.nextState], [5, "approved"]);
  assert.deepEqual([rejected.newVersion, rejected.nextState], [5, "rejected"]);
  assert.deepEqual([corrected.newVersion, corrected.nextState], [5, "review_required"]);
  assert.notEqual(approved.reviewEventId, rejected.reviewEventId);

  const resolution = await demo.resolveReconciliation(identity, { exceptionId: "e1", expectedVersion: 2, action: "accept_reconciliation", reasonCode: "ok" });
  assert.deepEqual([resolution.accepted, resolution.newVersion, resolution.status], [true, 3, "resolved"]);

  const publication = await demo.publish(identity, { snapshotId: "s1", action: "publish", expectedVersion: 1 });
  assert.equal(publication.accepted, true);
  assert.ok(publication.publicationEventId);
});

test("demo audit, readiness and export", async () => {
  const demo = platform();
  await demo.audit({
    id: "00000000-0000-0000-0000-000000000099", tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: "session-1",
    action: "review", targetType: "observation", targetId: "o1", outcome: "success", correlationId: "c1", occurredAt: "2026-09-19T00:00:00.000Z",
  });
  assert.deepEqual(await demo.readiness(), {
    identity: "demo", objectStore: "demo", postgres: "demo", orchestration: "demo", retrieval: "demo", ai: "demo", observability: "demo",
  });
  const manifest = await demo.export(identity, "csv");
  assert.equal(manifest.tenantId, identity.tenantId);
  assert.deepEqual([manifest.format, manifest.snapshotIds, manifest.rowCounts, manifest.checksumSha256, manifest.schemaVersion, manifest.taxonomyVersion], ["csv", [], {}, "demo", "v1", "v1"]);
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
});
