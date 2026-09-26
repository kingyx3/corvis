import { workspaceContext } from "../../lib/workspace-context.ts";
import type { Permission, ResearchPin } from "@/core/enterprise";
import type { TenantAccessMember, WorkspaceIdentity, WorkspacePort } from "@/core/workspace";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";
import { demoExposureDimensionFacts, portfolioValueFacts } from "@/adapters/demo/catalog";
import { demoCompanySectorStore } from "@/adapters/demo/company-sector-store";
import { buildWorkspaceSummary } from "@/core/workspace-summary";

// Matches the CORVIS_DEMO_MODE defaults in lib/server/request-context.ts, so
// the client-side demo port and the server-side demo identity path agree.
const DEMO_TENANT_DISPLAY_NAME = "Meridian Capital Partners";
const DEMO_WORKSPACE_DISPLAY_NAME = "Primary Workspace";

// Demo sessions can simulate a read-only viewer or a tenant admin
// (sessionStorage "corvis:demo:role" = "read_only" | "admin") to exercise
// capability-aware presentation without a real Postgres-backed membership.
function secondaryWorkspace(): boolean { return workspaceContext()?.workspaceId === "demo-secondary"; }

function demoRole(): "read_only" | "admin" | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem("corvis:demo:role");
  return value === "read_only" || value === "admin" ? value : null;
}

// Optional product modules are independent from RBAC. Keep the portfolio
// attribution module enabled by default in demo mode for existing journeys,
// while allowing E2E to prove the fund-down experience works with it disabled.
function demoPortfolioAttributionEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.sessionStorage.getItem("corvis:demo:feature:portfolio_attribution") !== "disabled";
}

export function createDemoWorkspacePort(): WorkspacePort {
  let researchPins: ResearchPin[] = [];
  let accessMembers: TenantAccessMember[] = [
    {
      userId: "00000000-0000-4000-8000-000000000001",
      subjects: [{ authMethod: "oidc", subject: "demo-user" }],
      memberships: [{ workspaceId: "00000000-0000-4000-8000-000000000101", workspaceName: DEMO_WORKSPACE_DISPLAY_NAME, roleName: "tenant_admin" }],
      entitlements: [],
      isCurrentUser: true,
    },
    {
      userId: "00000000-0000-4000-8000-000000000002",
      subjects: [{ authMethod: "oidc", subject: "jordan.lee@example.test" }],
      memberships: [
        { workspaceId: "00000000-0000-4000-8000-000000000101", workspaceName: DEMO_WORKSPACE_DISPLAY_NAME, roleName: "analyst" },
        { workspaceId: "00000000-0000-4000-8000-000000000102", workspaceName: "Secondary Workspace", roleName: "viewer" },
      ],
      entitlements: [
        { workspaceId: "00000000-0000-4000-8000-000000000101", workspaceName: DEMO_WORKSPACE_DISPLAY_NAME, resourceType: "fund", resourceId: "fund-demo-1", permission: "read" },
        { workspaceId: "00000000-0000-4000-8000-000000000102", workspaceName: "Secondary Workspace", resourceType: "document", resourceId: "document-demo-2", permission: "read" },
      ],
      isCurrentUser: false,
    },
  ];

  return {
    async changeMemberRole(command) {
      if (demoRole() !== "admin") throw new Error("tenant_admin_required");
      const member = accessMembers.find((item) => item.userId === command.userId);
      if (!member || member.isCurrentUser) throw new Error("member_not_found");
      const membership = member.memberships.find((item) => item.workspaceId === command.workspaceId && item.roleName === command.expectedRole);
      if (!membership) throw new Error("membership_changed_refresh_required");
      if (command.roleName === "tenant_admin" && !command.confirmTenantAdmin) throw new Error("tenant_admin_confirmation_required");
      if (command.roleName) membership.roleName = command.roleName;
      else member.memberships = member.memberships.filter((item) => item !== membership);
      return { auditEventId: crypto.randomUUID(), userId: command.userId, workspaceId: command.workspaceId, roleName: command.roleName };
    },
    async capabilities() {
      const features = { portfolioAttribution: demoPortfolioAttributionEnabled() };
      const role = demoRole();
      if (role === "read_only" || secondaryWorkspace()) {
        return { permissions: secondaryWorkspace() ? ["documents:read"] : ["documents:read", "observations:read"], sourceDocumentAccessAllowed: false, redistributionAllowed: false, features };
      }
      const permissions: Permission[] = [
        "documents:read",
        "documents:write",
        "sources:read",
        "observations:read",
        "observations:review",
        "snapshots:publish",
        "research:query",
        "exports:create",
      ];
      if (role === "admin") permissions.push("admin:manage");
      return {
        permissions,
        sourceDocumentAccessAllowed: true,
        redistributionAllowed: true,
        features,
      };
    },
    async whoAmI(): Promise<WorkspaceIdentity> {
      return {
        subject: "demo-user",
        tenantId: "demo-tenant",
        workspaceId: secondaryWorkspace() ? "demo-secondary" : "demo-workspace",
        tenantDisplayName: DEMO_TENANT_DISPLAY_NAME,
        workspaceDisplayName: secondaryWorkspace() ? "Secondary Workspace" : DEMO_WORKSPACE_DISPLAY_NAME,
        tenantAdmin: demoRole() === "admin",
      };
    },
    async listMyWorkspaces() {
      // The second workspace intentionally has no data and read-only capabilities.
      const role = demoRole();
      return [{ workspaceId: "demo-workspace", workspaceDisplayName: DEMO_WORKSPACE_DISPLAY_NAME, roles: [role ?? "analyst"] }, { workspaceId: "demo-secondary", workspaceDisplayName: "Secondary Workspace", roles: ["read_only"] }];
    },
    async listDocuments() {
      assertDemoModuleAvailable("documents");
      return secondaryWorkspace() ? [] : demoCustomerJourneyStore.listDocuments();
    },
    async listObservations() {
      assertDemoModuleAvailable("observations");
      return secondaryWorkspace() ? [] : demoCustomerJourneyStore.listObservations();
    },
    async listSnapshots() {
      assertDemoModuleAvailable("snapshots");
      return secondaryWorkspace() ? [] : demoCustomerJourneyStore.listSnapshots();
    },
    async workspaceSummary() {
      assertDemoModuleAvailable("snapshots");
      if (secondaryWorkspace()) return buildWorkspaceSummary({ snapshots: [], observations: [], documents: [], valueFacts: [], now: new Date() });
      const snapshots = demoCustomerJourneyStore.listSnapshots();
      // Mirror the server rule: only a snapshot whose current state is
      // published contributes value; history rows have no live snapshot.
      const unpublished = new Set(snapshots.filter((snapshot) => snapshot.status !== "Published").map((snapshot) => snapshot.id));
      const role = demoRole();
      return buildWorkspaceSummary({
        snapshots,
        observations: demoCustomerJourneyStore.listObservations(),
        documents: demoCustomerJourneyStore.listDocuments(),
        valueFacts: portfolioValueFacts.filter((fact) => !unpublished.has(fact.snapshotId)),
        dimensionFacts: demoExposureDimensionFacts(demoCompanySectorStore().sectorByCompany()).filter((fact) => !unpublished.has(fact.snapshotId)),
        sources: role === "admin" ? [{ sourceConnectionId: "demo-source-sharepoint", connectionLabel: "GP data room (SharePoint)", status: "reauthorization_required", consecutiveFailures: 3, lastErrorClass: "auth_expired", lastSuccessAt: "2026-09-18" }] : undefined,
        now: new Date(),
      });
    },
    async listCompanySectors() {
      return demoCompanySectorStore().list();
    },
    async assignCompanySector(command) {
      const result = demoCompanySectorStore().assign("demo|reviewer", command);
      if ("refused" in result) throw new Error(result.refused);
      return { accepted: true as const, companyId: command.companyId, sectorCode: command.sectorCode, newVersion: result.newVersion };
    },
    async listAccessMembers() {
      if (demoRole() !== "admin") throw new Error("tenant_admin_required");
      return accessMembers.map((member) => ({
        ...member,
        subjects: member.subjects.map((entry) => ({ ...entry })),
        memberships: member.memberships.map((entry) => ({ ...entry })),
        entitlements: member.entitlements.map((entry) => ({ ...entry })),
      }));
    },
    async deactivateAccessMember(command) {
      if (demoRole() !== "admin") throw new Error("tenant_admin_required");
      const member = accessMembers.find((entry) => entry.userId === command.userId);
      if (!member) throw new Error("member_not_found");
      if (member.isCurrentUser) throw new Error("cannot_deactivate_current_user");
      accessMembers = accessMembers.filter((entry) => entry.userId !== command.userId);
      return {
        eventKey: `demo-deactivate-${crypto.randomUUID()}`,
        operation: "disable" as const,
        subject: member.subjects[0]?.subject ?? command.userId,
        userId: command.userId,
        activeMemberships: 0,
        revokedMemberships: member.memberships.length,
        expiredEntitlements: member.entitlements.length,
        disabledSubjects: member.subjects.length,
        disabledServiceGrants: 0,
      };
    },
    async createAccessInvitation() {
      throw new Error("tenant_invitations_unavailable_in_demo");
    },
    async listAccessInvitations() {
      return [];
    },
    async listReconciliationExceptions() {
      return [];
    },
    async research(question, signal) {
      signal?.throwIfAborted();
      assertDemoModuleAvailable("research");
      return demoCustomerJourneyStore.research(question);
    },
    async researchStream(question, onEvent, signal) {
      signal?.throwIfAborted();
      assertDemoModuleAvailable("research");
      onEvent({ type: "progress", phase: "planning" });
      signal?.throwIfAborted();
      onEvent({ type: "progress", phase: "retrieval" });
      signal?.throwIfAborted();
      onEvent({ type: "progress", phase: "generation" });
      const data = await demoCustomerJourneyStore.research(question);
      signal?.throwIfAborted();
      onEvent({ type: "result", data });
      return data;
    },
    async listResearchPins() {
      return secondaryWorkspace() ? [] : [...researchPins].sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
    },
    async pinResearchAnswer(command) {
      assertDemoModuleAvailable("research");
      const pin: ResearchPin = { pinId: crypto.randomUUID(), question: command.question, answer: command.answer, askedAt: command.askedAt, pinnedAt: new Date().toISOString() };
      researchPins = [pin, ...researchPins].slice(0, 50);
      return pin;
    },
    async unpinResearchAnswer(pinId) {
      researchPins = researchPins.filter((pin) => pin.pinId !== pinId);
    },
    async sourceEvidence(sourceReferenceId) {
      return demoCustomerJourneyStore.sourceEvidence(sourceReferenceId);
    },
    async review(command) {
      demoCustomerJourneyStore.review(command);
      return {
        accepted: true,
        reviewEventId: crypto.randomUUID(),
        newVersion: command.expectedVersion + 1,
        nextState: command.decision === "approve" ? "approved" as const : command.decision === "reject" ? "rejected" as const : "review_required" as const,
      };
    },
    async resolveReconciliation(command) {
      return { accepted: true, resolutionEventId: crypto.randomUUID(), newVersion: command.expectedVersion + 1, status: "resolved" as const };
    },
    async publish(command) {
      demoCustomerJourneyStore.publish(command);
    },
  };
}
