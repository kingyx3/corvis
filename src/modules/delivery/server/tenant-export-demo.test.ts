import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { DemoTenantExportStore as DemoTenantExportStoreType } from "../adapters/tenant-export-store.ts";
import type { TenantExportManifest, TenantExportRequest } from "../domain/tenant-export.ts";
import { createHash } from "node:crypto";
import { publicTenantExportManifest } from "./tenant-export-bundle.ts";
import { readStoredZip } from "../../../test-support/zip-reader.ts";

// See src/modules/sources/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;

// Demo mode must never reach a database or an object store: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { DemoRetentionStore } = await import("../../governance/adapters/data-retention-store.ts");
const { DemoTenantExportStore } = await import("../adapters/tenant-export-store.ts");
type DemoTenantExportStore = DemoTenantExportStoreType;
const { DataGovernanceError } = await import("../../governance/server/data-governance.ts");
const { GET: retentionGet } = await import("@/app/api/v1/access/retention/route");
const { GET: listGet, POST: requestPost } = await import("@/app/api/v1/access/data-exports/route");
const { GET: itemGet, POST: itemPost } = await import("@/app/api/v1/access/data-exports/[exportId]/route");
const { GET: downloadGet, HEAD: downloadHead } = await import("@/app/api/v1/access/data-exports/[exportId]/download/route");
const { createTenantExportService, demoTenantExportService, overrideTenantExportService, postgresTenantExportService, tenantExportService } = await import("./tenant-export-service.ts");
const { createRetentionService, demoRetentionService, overrideRetentionService, postgresRetentionService, retentionService } = await import("../../governance/server/data-retention.ts");
const { platform } = await import("../../../platform/platform.ts");

const HOUR = 60 * 60 * 1000;
const EVERYTHING = { limit: 200 };
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataGovernanceError && error.code === code && error.status === status;

let clock = new Date("2026-10-02T12:00:00.000Z");
const store = () => new DemoTenantExportStore(() => clock);
function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-admin", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["admin"], isTenantAdmin: true, authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const second = (overrides: Partial<RequestIdentity> = {}) => identity({ subject: "second-admin", ...overrides });
async function pendingSeed(demo: DemoTenantExportStore, who = identity()): Promise<TenantExportRequest> {
  return (await demo.list(who, EVERYTHING)).items.find((item) => item.status === "pending_approval")!;
}
async function opened(demo: DemoTenantExportStore, who = identity()): Promise<TenantExportRequest> {
  // The seeded request is the open one; resolve it so this admin can make their own.
  await demo.decide(who, (await pendingSeed(demo, who)).requestId, { action: "reject", note: "Superseded." });
  return demo.request(who, { reason: "Records review at contract end" });
}

// ------------------------------------------------------------------ store
test("each demo tenant is seeded once with a rejected request, a built export and a colleague's request awaiting this admin", async () => {
  const demo = store();
  const items = (await demo.list(identity(), EVERYTHING)).items;
  assert.deepEqual(items.map((item) => item.status), ["pending_approval", "complete", "rejected"], "newest first");
  const [pending, built, rejected] = items as [TenantExportRequest, TenantExportRequest, TenantExportRequest];
  assert.equal(pending.requestedByMe, false);
  assert.deepEqual(pending.actions, { canApprove: true, canReject: true, canCancel: false, canDownload: false });
  assert.equal(built.actions.canDownload, true);
  assert.equal(built.artifact!.manifest.approvedBy, "morgan.lee@meridian.example");
  assert.equal(rejected.decisionNote, "Please scope this to the audit team's own request first.");
  assert.equal((await demo.list(identity(), EVERYTHING)).items.length, 3, "listing again does not seed again");
  assert.equal((await demo.list(identity({ tenantId: "tenant-other" }), EVERYTHING)).items.length, 3, "another tenant gets its own seeds");
  const detail = await demo.get(identity(), built.requestId);
  assert.deepEqual(detail.history!.map((event) => [event.eventType, event.actor]), [
    ["requested", "alex.chen@meridian.example"], ["approved", "morgan.lee@meridian.example"], ["build_started", "system:tenant-export"], ["build_completed", "system:tenant-export"],
  ]);
});

test("a request needs the open one resolved first, and the requester can neither approve, reject nor have it built", async () => {
  const demo = store();
  await assert.rejects(() => demo.request(identity(), { reason: "Records review" }), refusal("data_export_already_active", 409));
  const mine = await opened(demo);
  assert.equal(mine.status, "pending_approval");
  assert.equal(mine.requestedByMe, true);
  assert.deepEqual(mine.actions, { canApprove: false, canReject: false, canCancel: true, canDownload: false });
  await assert.rejects(() => demo.request(second(), { reason: "Another" }), refusal("data_export_already_active", 409));
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "approve" }), refusal("data_export_independent_approver_required", 403));
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "reject", note: "No" }), refusal("data_export_independent_approver_required", 403));
  assert.equal((await demo.get(identity(), mine.requestId)).status, "pending_approval", "refused decisions change nothing");
  assert.equal((await demo.get(identity(), mine.requestId)).artifact, null, "nothing was built");
});

test("a different admin approves, and the export is built with a verifiable manifest of exactly what it holds and leaves out", async () => {
  const demo = store();
  const mine = await opened(demo);
  const approved = await demo.decide(second(), mine.requestId, { action: "approve", note: "Approved for the audit.", expectedStatus: "pending_approval" });
  assert.equal(approved.status, "complete");
  assert.deepEqual([approved.decidedBy, approved.decisionNote], ["second-admin", "Approved for the audit."]);
  assert.equal(approved.actions.canDownload, true);
  const history = (await demo.get(identity(), mine.requestId)).history!;
  assert.deepEqual(history.map((event) => event.eventType), ["requested", "approved", "build_started", "build_completed"]);
  assert.deepEqual(history.map((event) => event.actor), ["demo-admin", "second-admin", "system:tenant-export", "system:tenant-export"]);

  const { download } = await demo.issueDownload(identity(), mine.requestId);
  const token = new URL(download.downloadUrl, "https://corvis.test").searchParams.get("grant")!;
  const redeemed = (await demo.redeemDownload(identity(), mine.requestId, token))!;
  const stream = (await demo.openArtifact(identity(), mine.requestId))!;
  const bytes = Buffer.from(stream.body as Uint8Array);
  assert.equal(String(bytes.length), stream.contentLength);
  assert.equal(redeemed.checksumSha256, approved.artifact!.checksumSha256, "the delivered checksum is the recorded one");

  const entries = readStoredZip(bytes);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as TenantExportManifest;
  assert.deepEqual(publicTenantExportManifest(manifest), approved.artifact!.manifest, "the request shows the manifest without the individual source files");
  assert.deepEqual([manifest.requestedBy, manifest.approvedBy], ["demo-admin", "second-admin"]);
  assert.deepEqual(manifest.files.map((file) => file.path), [
    "README.txt", "published-data/observations-0001.csv", "access-audit/access-audit-0001.csv", "source-documents/inventory-0001.csv",
    "source-documents/files/doc-adv-viii-q2/Advent International GPE VIII _ Q2 2026.pdf.txt",
  ]);
  for (const file of manifest.files) assert.equal(file.sha256, createHash("sha256").update(entries.get(file.path)!).digest("hex"), file.path);
  // Source files: the one document the organization holds source-file access for is in the archive; the other is counted.
  assert.deepEqual(manifest.sourceFiles, { included: 1, excluded: 1, totalBytes: manifest.files.at(-1)!.sizeBytes });
  assert.deepEqual(manifest.fileCount, 5);
  assert.equal(approved.artifact!.manifest.files.length, 4);
  // Contractual data rights: Hg Genesis 9 is not redistributable, so its figures never reach the archive, and it is counted as left out.
  assert.deepEqual(manifest.dataRights.funds, { included: 2, excluded: 1 });
  assert.deepEqual(manifest.dataRights.documents, { included: 2, excluded: 2 });
  const observations = entries.get("published-data/observations-0001.csv")!.toString("utf8");
  assert.match(observations, /fund-advent-viii/);
  assert.doesNotMatch(observations, /fund-hg-genesis-9/);
  assert.match(entries.get("access-audit/access-audit-0001.csv")!.toString("utf8"), /data_export\.approved/);
  assert.ok(manifest.notIncluded.some((entry) => entry.item === "Source document files"));
});

test("with a build time the export is building, shows its size estimate and progress, and completes as the clock runs (F10c)", async () => {
  const started = new Date("2026-10-02T12:00:00.000Z");
  let now = started;
  const demo = new DemoTenantExportStore(() => now, 3000);
  const mine = await opened(demo);
  const building = await demo.decide(second(), mine.requestId, { action: "approve", expectedStatus: "pending_approval" });
  assert.equal(building.status, "building");
  assert.equal(building.artifact, null);
  assert.deepEqual(building.progress, { ...building.progress!, phase: "data", percent: 0, bytesWritten: 0, rowsWritten: 0, documentsWritten: 0 });
  assert.ok(building.progress!.estimatedBytes > 86_400_000, "the estimate counts the source file the export will carry");
  assert.deepEqual([building.progress!.estimatedDocuments, building.progress!.estimatedRows > 0], [1, true]);
  assert.deepEqual(building.actions, { canApprove: false, canReject: false, canCancel: false, canDownload: false });
  await assert.rejects(() => demo.issueDownload(identity(), mine.requestId), refusal("data_export_not_available", 409));

  now = new Date(started.getTime() + 1500);
  const half = (await demo.get(identity(), mine.requestId)).progress!;
  assert.equal(half.phase, "documents");
  assert.ok(half.percent > 0 && half.percent < 99, `partway (${half.percent}%)`);
  assert.ok(half.bytesWritten > 0 && half.bytesWritten < half.estimatedBytes);
  assert.equal(half.documentsWritten, 0);
  assert.equal((await demo.get(identity(), mine.requestId)).history!.at(-1)!.eventType, "build_started");

  now = new Date(started.getTime() + 2900);
  const last = (await demo.get(identity(), mine.requestId)).progress!;
  assert.deepEqual([last.phase, last.documentsWritten], ["finalizing", 1]);
  assert.ok(last.percent <= 99);

  now = new Date(started.getTime() + 3000);
  const done = await demo.get(identity(), mine.requestId);
  assert.equal(done.status, "complete");
  assert.equal(done.progress, null);
  assert.equal(done.actions.canDownload, true);
  assert.deepEqual(done.history!.map((event) => event.eventType), ["requested", "approved", "build_started", "build_completed"]);
  assert.equal(done.artifact!.manifest.sourceFiles!.included, 1);
  // The seeded export, built before anyone looked, is complete at once whatever the build time.
  assert.equal((await demo.list(identity(), EVERYTHING)).items.filter((item) => item.status === "complete").length, 2);
});

test("reject needs a different admin and a note, only the requester may withdraw, and a decided request is final", async () => {
  const demo = store();
  const mine = await opened(demo);
  await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "cancel" }), refusal("data_export_cancel_requester_only", 403));
  await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "approve", expectedStatus: "approved" }), refusal("data_export_status_changed", 409));
  const rejected = await demo.decide(second(), mine.requestId, { action: "reject", note: "Legal has not signed off." });
  assert.deepEqual([rejected.status, rejected.decidedBy, rejected.decisionNote], ["rejected", "second-admin", "Legal has not signed off."]);
  for (const action of ["approve", "cancel"] as const) await assert.rejects(() => demo.decide(second(), mine.requestId, { action }), refusal("data_export_transition_not_allowed", 409));
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "cancel" }), refusal("data_export_transition_not_allowed", 409));

  const next = await demo.request(identity(), { reason: "A narrower request" });
  const withdrawn = await demo.decide(identity(), next.requestId, { action: "cancel", note: "Wrong scope" });
  assert.equal(withdrawn.status, "cancelled");
  assert.equal(withdrawn.cancelledAt, clock.toISOString());
  assert.equal(withdrawn.decidedBy, null, "withdrawing a pending request records no decision");
  assert.deepEqual((await demo.get(identity(), next.requestId)).history!.at(-1), { eventType: "cancelled", fromState: "pending_approval", toState: "cancelled", actor: "demo-admin", note: "Wrong scope", at: clock.toISOString() });
  await assert.rejects(() => demo.decide(second(), "00000000-0000-4000-8000-000000000000", { action: "approve" }), refusal("data_export_not_found", 404));
  await assert.rejects(() => demo.decide(second(), "not-a-uuid", { action: "approve" }), refusal("data_export_not_found", 404));
  await assert.rejects(() => demo.get(identity({ tenantId: "tenant-other" }), mine.requestId), refusal("data_export_not_found", 404));
});

test("an approval window that passes lapses the request: it cannot be approved, shows as expired and frees the slot", async () => {
  const demo = store();
  const mine = await opened(demo);
  clock = new Date(clock.getTime() + 169 * HOUR);
  try {
    assert.equal((await demo.list(identity(), EVERYTHING)).items.find((item) => item.requestId === mine.requestId)!.status, "expired");
    await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "approve" }), refusal("data_export_approval_expired", 409));
    const fresh = await demo.request(identity(), { reason: "A fresh request" });
    assert.equal(fresh.status, "pending_approval");
    const lapsed = await demo.get(identity(), mine.requestId);
    assert.equal(lapsed.status, "expired");
    assert.deepEqual(lapsed.history!.at(-1)!.actor, "system:tenant-export");
    await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "approve" }), refusal("data_export_transition_not_allowed", 409));
  } finally {
    clock = new Date("2026-10-02T12:00:00.000Z");
  }
});

test("a download link is single-use, bound to its admin and request, short-lived, and gone when the export expires", async () => {
  const demo = store();
  const built = (await demo.list(identity(), EVERYTHING)).items.find((item) => item.status === "complete")!;
  const waiting = await pendingSeed(demo);
  await assert.rejects(() => demo.issueDownload(identity(), waiting.requestId), refusal("data_export_not_available", 409));
  await assert.rejects(() => demo.issueDownload(identity(), "00000000-0000-4000-8000-000000000000"), refusal("data_export_not_found", 404));

  const { request, download } = await demo.issueDownload(identity(), built.requestId);
  assert.equal(request.status, "complete");
  assert.equal(Date.parse(download.downloadExpiresAt) - clock.getTime(), 10 * 60_000);
  const token = new URL(download.downloadUrl, "https://corvis.test").searchParams.get("grant")!;
  assert.equal(await demo.redeemDownload(second(), built.requestId, token), null, "another admin cannot use it");
  assert.equal(await demo.redeemDownload(identity(), waiting.requestId, token), null, "it is for one request");
  assert.equal(await demo.redeemDownload(identity(), built.requestId, "wrong"), null);
  assert.equal(await demo.redeemDownload(identity(), "nope", token), null);
  assert.equal(await demo.redeemDownload(identity(), built.requestId, ""), null);
  assert.ok(await demo.redeemDownload(identity(), built.requestId, token));
  assert.equal(await demo.redeemDownload(identity(), built.requestId, token), null, "it works once");

  const stale = (await demo.issueDownload(identity(), built.requestId)).download.downloadUrl;
  clock = new Date(clock.getTime() + 11 * 60_000);
  try {
    assert.equal(await demo.redeemDownload(identity(), built.requestId, new URL(stale, "https://corvis.test").searchParams.get("grant")!), null, "an expired link redeems nothing");
    clock = new Date(clock.getTime() + 25 * HOUR);
    assert.equal((await demo.list(identity(), EVERYTHING)).items.find((item) => item.requestId === built.requestId)!.status, "download_expired");
    await assert.rejects(() => demo.issueDownload(identity(), built.requestId), refusal("data_export_not_available", 409));
  } finally {
    clock = new Date("2026-10-02T12:00:00.000Z");
  }
  assert.equal(await demo.openArtifact(identity(), "00000000-0000-4000-8000-000000000000"), null);
  assert.equal(await demo.openArtifact(identity(), waiting.requestId), null, "an unbuilt request has no archive");
});

test("a link for an export that expired in between redeems nothing", async () => {
  const demo = store();
  const built = (await demo.list(identity(), EVERYTHING)).items.find((item) => item.status === "complete")!;
  const { download } = await demo.issueDownload(identity(), built.requestId);
  clock = new Date(clock.getTime() + 20 * HOUR);
  try {
    // 20h later the link (10 minutes) is long gone even though the archive (24h) is not.
    assert.equal(await demo.redeemDownload(identity(), built.requestId, new URL(download.downloadUrl, "https://corvis.test").searchParams.get("grant")!), null);
  } finally {
    clock = new Date("2026-10-02T12:00:00.000Z");
  }
});

test("the retention view is the same read-only policy for every demo tenant", async () => {
  const view = await new DemoRetentionStore().view(identity());
  assert.deepEqual(view.policies.map((policy) => [policy.dataClass, policy.retentionLabel, policy.legalHold, policy.deleteOnTermination]), [
    ["financials", "7 years", false, false],
    ["published_data", "No fixed retention period", false, true],
    ["audit", "5 years", false, false],
    ["source_documents", "10 years", true, false],
  ]);
  assert.deepEqual(view.legalHolds.map((hold) => [hold.matterReference, hold.label, hold.scopeLabel]), [["MATTER-2026-014", "Source documents", "3 documents within source documents"]]);
  assert.equal(view.policies.every((policy) => policy.inEffect), true);
  assert.deepEqual(view.deletionRequests.map((item) => [item.origin, item.status, item.legalHoldBlocks]), [["customer", "pending_approval", false], ["corvis", "blocked", true], ["corvis", "completed", false]], "deletion requests are listed newest first, with whether a legal hold blocks each");
});

// ------------------------------------------------------------------ service
test("the service lets only Organization Admins act and audits exactly what changed, with identifiers and the status", async () => {
  const events: AuditEvent[] = [];
  const service = createTenantExportService(store());
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const colleague = identity({ subject: "member", roles: ["analyst"], isTenantAdmin: false });
    const accountAdmin = identity({ subject: "workspace-admin", isTenantAdmin: false });
    for (const who of [colleague, accountAdmin, identity({ isTenantAdmin: undefined })]) {
      await assert.rejects(() => service.list(who, EVERYTHING), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.get(who, "x"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.request(who, { reason: "Records review" }, "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.decide(who, "x", { action: "approve" }, "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.prepareDownload(who, "x", "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.download(who, "x", "g", "c"), refusal("tenant_admin_required", 403));
    }
    assert.equal(events.length, 0, "a refused command is not audited");

    const seeded = (await service.list(identity(), EVERYTHING)).items.find((item) => item.status === "pending_approval")!;
    await assert.rejects(() => service.request(identity(), { reason: "Records review" }, "corr-0"), refusal("data_export_already_active", 409));
    await service.decide(second(), seeded.requestId, { action: "reject", note: "Not now" }, "corr-1");
    const mine = await service.request(identity(), { reason: "Records review at contract end" }, "corr-2");
    await assert.rejects(() => service.decide(identity(), mine.requestId, { action: "approve" }, "corr-3"), refusal("data_export_independent_approver_required", 403));
    assert.deepEqual(events.map((event) => [event.action, event.actorSubject, event.targetType, event.correlationId, event.metadata?.status]), [
      ["data_export.rejected", "second-admin", "tenant_export_request", "corr-1", "rejected"],
      ["data_export.requested", "demo-admin", "tenant_export_request", "corr-2", "pending_approval"],
    ], "the refused approval of one's own request left no success audit");
    assert.equal(events[0]!.metadata?.note, "Not now");
    assert.equal(events[1]!.metadata?.reason, "Records review at contract end");
    assert.equal(events.every((event) => event.targetId && !JSON.stringify(event).includes("approvalExpiresAt")), true);

    const approved = await service.decide(second(), mine.requestId, { action: "approve" }, "corr-4");
    assert.equal(approved.status, "complete");
    assert.equal(events.at(-1)!.action, "data_export.approved");
    assert.equal(events.at(-1)!.metadata?.note, undefined, "no note, none recorded");
    assert.equal((await service.get(identity(), mine.requestId)).history!.length, 4);

    const link = await service.prepareDownload(identity(), mine.requestId, "corr-5");
    assert.equal(events.at(-1)!.action, "data_export.link_issued");
    assert.equal(events.at(-1)!.metadata?.linkExpiresAt, link.downloadExpiresAt);
    const grant = new URL(link.downloadUrl, "https://corvis.test").searchParams.get("grant")!;
    const download = (await service.download(identity(), mine.requestId, grant, "corr-6"))!;
    assert.deepEqual([download.contentType, download.filename, download.checksumSha256], ["application/zip", "corvis-tenant-export.zip", approved.artifact!.checksumSha256]);
    assert.deepEqual(events.at(-1) && [events.at(-1)!.action, events.at(-1)!.metadata?.checksumSha256], ["data_export.download_started", approved.artifact!.checksumSha256]);
    const before = events.length;
    assert.equal(await service.download(identity(), mine.requestId, grant, "corr-7"), null, "a used link redeems nothing");
    assert.equal(events.length, before, "a link that matched nothing changed nothing, so it is not audited as a success");
    await assert.rejects(() => service.prepareDownload(identity(), seeded.requestId, "corr-8"), refusal("data_export_not_available", 409));
  } finally {
    port.audit = original;
  }
});

test("a redeemed link whose archive cannot be read answers nothing instead of an empty file", async () => {
  const backend = store();
  const service = createTenantExportService({
    demo: true,
    request: (who, command) => backend.request(who, command),
    list: (who, query) => backend.list(who, query),
    get: (who, id) => backend.get(who, id),
    decide: (who, id, command) => backend.decide(who, id, command),
    issueDownload: (who, id) => backend.issueDownload(who, id),
    redeemDownload: (who, id, token) => backend.redeemDownload(who, id, token),
    openArtifact: async () => null,
  });
  const built = (await service.list(identity(), EVERYTHING)).items.find((item) => item.status === "complete")!;
  const link = await service.prepareDownload(identity(), built.requestId, "c");
  assert.equal(await service.download(identity(), built.requestId, new URL(link.downloadUrl, "https://corvis.test").searchParams.get("grant")!, "c"), null);
});

test("the service and the retention view are selected by mode and can be pinned by a test", async () => {
  assert.equal(tenantExportService(), demoTenantExportService);
  assert.equal(retentionService(), demoRetentionService);
  assert.notEqual(demoTenantExportService, postgresTenantExportService);
  assert.notEqual(demoRetentionService, postgresRetentionService);
  const pinned = createTenantExportService(store());
  overrideTenantExportService(pinned);
  overrideRetentionService(createRetentionService({ view: async () => ({ policies: [], legalHolds: [], deletionRequests: [] }) }));
  try {
    assert.equal(tenantExportService(), pinned);
    assert.deepEqual(await retentionService().view(identity()), { policies: [], legalHolds: [], deletionRequests: [] });
  } finally {
    overrideTenantExportService();
    overrideRetentionService();
  }
  assert.equal(tenantExportService(), demoTenantExportService);
  await assert.rejects(() => demoRetentionService.view(identity({ isTenantAdmin: false })), refusal("tenant_admin_required", 403));
  assert.equal((await demoRetentionService.view(identity())).policies.length, 4);
});

// ------------------------------------------------------------------ routes
type Options = { method?: string; tenant?: string; subject?: string; roles?: string; body?: unknown; rawBody?: string };
function request(path: string, options: Options = {}): Request {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-corvis-demo-tenant": options.tenant ?? "tenant-routes",
      "x-corvis-demo-subject": options.subject ?? "route-admin",
      "x-corvis-demo-roles": options.roles ?? "admin",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? (options.rawBody ?? JSON.stringify(options.body)) : undefined,
  });
}
const params = (exportId: string) => ({ params: Promise.resolve({ exportId }) });
type Json = { error?: string; data: TenantExportRequest & TenantExportRequest[] & { policies: unknown[]; legalHolds: unknown[]; downloadUrl: string; downloadExpiresAt: string } };
const body = async (response: Response) => (await response.json()) as Json;

test("the retention route is read-only and Organization-Admin-only", async () => {
  const ok = await retentionGet(request("/access/retention"));
  assert.equal(ok.status, 200);
  assert.equal((await body(ok)).data.policies.length, 4);
  const analyst = await retentionGet(request("/access/retention", { roles: "analyst" }));
  assert.equal(analyst.status, 403);
  assert.equal((await body(analyst)).error, "forbidden", "a role without admin:manage is refused before anything else");
});

test("the whole export flow runs through the routes: request, approve by a second admin, build, link, download once", async () => {
  // A request approved through the routes is built over a few seconds in the browser composition: the same store, with a clock this test drives.
  let flowClock = new Date("2026-10-02T12:00:00.000Z");
  overrideTenantExportService(createTenantExportService(new DemoTenantExportStore(() => flowClock, 3000)));
  try { await flow(() => { flowClock = new Date(flowClock.getTime() + 5000); }); } finally { overrideTenantExportService(); }
});

async function flow(finishBuild: () => void): Promise<void> {
  const tenant = "tenant-flow";
  const seeded = (await body(await listGet(request("/access/data-exports", { tenant })))).data;
  assert.deepEqual(seeded.map((item) => item.status), ["pending_approval", "complete", "rejected"]);

  // The seeded request is open, so a new one is refused until it is decided.
  const blocked = await requestPost(request("/access/data-exports", { method: "POST", tenant, body: { reason: "Records review" } }));
  assert.equal(blocked.status, 409);
  assert.equal((await body(blocked)).error, "data_export_already_active");
  const rejected = await itemPost(request(`/access/data-exports/${seeded[0]!.requestId}`, { method: "POST", tenant, body: { action: "reject", note: "Superseded" } }), params(seeded[0]!.requestId));
  assert.equal(rejected.status, 200);

  const created = await requestPost(request("/access/data-exports", { method: "POST", tenant, body: { reason: "  Records review at contract end  " } }));
  assert.equal(created.status, 201);
  const mine = (await body(created)).data;
  assert.equal(mine.reason, "Records review at contract end");
  assert.equal(mine.requestedByMe, true);

  const self = await itemPost(request(`/access/data-exports/${mine.requestId}`, { method: "POST", tenant, body: { action: "approve" } }), params(mine.requestId));
  assert.equal(self.status, 403);
  assert.equal((await body(self)).error, "data_export_independent_approver_required");

  const approved = await itemPost(request(`/access/data-exports/${mine.requestId}`, { method: "POST", tenant, subject: "second-admin", body: { action: "approve", expectedStatus: "pending_approval" } }), params(mine.requestId));
  assert.equal(approved.status, 200);
  const building = (await body(approved)).data as TenantExportRequest;
  assert.equal(building.status, "building");
  assert.equal(building.progress!.phase, "data", "the response shows the estimate and progress while the export is built");
  assert.equal((await itemPost(request(`/access/data-exports/${mine.requestId}`, { method: "POST", tenant, body: { action: "prepare_download" } }), params(mine.requestId))).status, 409);
  finishBuild();
  assert.equal((await body(await itemGet(request(`/access/data-exports/${mine.requestId}`, { tenant }), params(mine.requestId)))).data.status, "complete");
  const detail = await itemGet(request(`/access/data-exports/${mine.requestId}`, { tenant }), params(mine.requestId));
  assert.equal((await body(detail)).data.history!.length, 4);

  const prepared = await itemPost(request(`/access/data-exports/${mine.requestId}`, { method: "POST", tenant, body: { action: "prepare_download" } }), params(mine.requestId));
  assert.equal(prepared.status, 200);
  const link = (await body(prepared)).data;
  const url = new URL(link.downloadUrl, "https://corvis.test");
  const file = await downloadGet(request(`${url.pathname.replace("/api/v1", "")}${url.search}`, { tenant }), params(mine.requestId));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/zip");
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="corvis-tenant-export.zip"');
  assert.equal(file.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  const archive = Buffer.from(await file.arrayBuffer());
  assert.equal(file.headers.get("x-corvis-checksum-sha256"), (await body(await itemGet(request(`/access/data-exports/${mine.requestId}`, { tenant }), params(mine.requestId)))).data.artifact!.checksumSha256);
  assert.equal(file.headers.get("content-length"), String(archive.length));
  assert.ok(readStoredZip(archive).has("manifest.json"));

  const again = await downloadGet(request(`${url.pathname.replace("/api/v1", "")}${url.search}`, { tenant }), params(mine.requestId));
  assert.equal(again.status, 404);
  assert.equal((await body(again)).error, "not_found");
  assert.equal((await downloadGet(request(`/access/data-exports/${mine.requestId}/download`, { tenant }), params(mine.requestId))).status, 404, "no grant, no file");
  const head = await downloadHead(request(`/access/data-exports/${mine.requestId}/download`, { method: "HEAD", tenant }));
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
}

test("the list is paged newest first with a stable cursor: every request once, none skipped when a newer one arrives between pages (F10f)", async () => {
  const demo = store();
  const everything = (await demo.list(identity(), EVERYTHING)).items.map((item) => item.requestId);
  assert.equal(everything.length, 3);
  const first = await demo.list(identity(), { limit: 1 });
  assert.deepEqual(first.items.map((item) => item.requestId), [everything[0]]);
  assert.ok(first.nextCursor);
  // A new request made between the two reads is newer than the cursor, so it neither shifts nor repeats the older pages.
  await demo.decide(identity(), everything[0]!, { action: "reject", note: "Superseded." });
  const added = await demo.request(identity(), { reason: "Records review at contract end" });
  const second = await demo.list(identity(), { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.requestId), [everything[1]]);
  const third = await demo.list(identity(), { limit: 5, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((item) => item.requestId), [everything[2]]);
  assert.equal(third.nextCursor, null, "the last page has no cursor");
  assert.equal((await demo.list(identity(), { limit: 4 })).nextCursor, null, "a page that holds everything has no cursor");
  assert.deepEqual((await demo.list(identity(), { limit: 1 })).items.map((item) => item.requestId), [added.requestId]);
  await assert.rejects(() => demo.list(identity(), { limit: 1, cursor: "!!!" }), /invalid_cursor/);
});

test("routes page the list with ?limit and ?cursor and refuse a malformed one (F10f)", async () => {
  const tenant = "tenant-paging";
  const first = await listGet(request("/access/data-exports?limit=2", { tenant }));
  const firstBody = (await first.json()) as { data: TenantExportRequest[]; nextCursor: string | null };
  assert.equal(firstBody.data.length, 2);
  assert.ok(firstBody.nextCursor);
  const second = (await (await listGet(request(`/access/data-exports?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, { tenant }))).json()) as { data: TenantExportRequest[]; nextCursor: string | null };
  assert.equal(second.data.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...firstBody.data, ...second.data].map((item) => item.requestId)).size, 3);
  const badCursor = await listGet(request("/access/data-exports?cursor=not-a-cursor", { tenant }));
  assert.equal(badCursor.status, 400);
  assert.equal((await body(badCursor)).error, "invalid_cursor");
  const badLimit = await listGet(request("/access/data-exports?limit=0", { tenant }));
  assert.equal(badLimit.status, 400);
  assert.equal((await body(badLimit)).error, "invalid_limit");
  const defaulted = (await (await listGet(request("/access/data-exports", { tenant }))).json()) as { data: unknown[]; nextCursor: string | null };
  assert.equal(defaulted.data.length, 3);
  assert.equal(defaulted.nextCursor, null);
});

test("routes validate input and answer plain, stable errors", async () => {
  const tenant = "tenant-validation";
  const post = (path: string, payload: unknown, extra: Options = {}) => requestPost(request(path, { method: "POST", tenant, body: payload, ...extra }));
  for (const [payload, error] of [[{}, "invalid_reason"], [{ reason: "ab" }, "invalid_reason"], [{ reason: 7 }, "invalid_reason"]] as const) {
    const response = await post("/access/data-exports", payload);
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, error);
  }
  const notJson = await requestPost(request("/access/data-exports", { method: "POST", tenant, rawBody: "{" }));
  assert.equal(notJson.status, 400);
  assert.equal((await body(notJson)).error, "invalid_request");
  const scalar = await requestPost(request("/access/data-exports", { method: "POST", tenant, rawBody: "null" }));
  assert.equal((await body(scalar)).error, "invalid_request");

  const id = (await body(await listGet(request("/access/data-exports", { tenant })))).data[0]!.requestId;
  for (const [payload, error] of [[{ action: "launch" }, "invalid_action"], [{ action: "approve", expectedStatus: "x" }, "invalid_status"], [{ action: "reject" }, "invalid_note"], ["x", "invalid_request"]] as const) {
    const response = await itemPost(request(`/access/data-exports/${id}`, { method: "POST", tenant, subject: "second-admin", body: payload }), params(id));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await body(response)).error, error);
  }
  const missing = await itemGet(request("/access/data-exports/not-a-uuid", { tenant }), params("not-a-uuid"));
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).error, "data_export_not_found");
  const analyst = await itemPost(request(`/access/data-exports/${id}`, { method: "POST", tenant, roles: "analyst", body: { action: "approve" } }), params(id));
  assert.equal(analyst.status, 403);
  const changed = await itemPost(request(`/access/data-exports/${id}`, { method: "POST", tenant, subject: "second-admin", body: { action: "approve", expectedStatus: "approved" } }), params(id));
  assert.equal(changed.status, 409);
  assert.equal((await body(changed)).error, "data_export_status_changed");
});
