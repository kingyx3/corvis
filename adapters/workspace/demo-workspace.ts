import type { Permission } from "@/core/enterprise";
import type { WorkspacePort } from "@/core/workspace";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";

// Demo sessions can simulate a read-only viewer or a tenant admin
// (sessionStorage "corvis:demo:role" = "read_only" | "admin") to exercise
// capability-aware presentation without a real Postgres-backed membership.
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
  return {
    async capabilities() {
      const features = { portfolioAttribution: demoPortfolioAttributionEnabled() };
      const role = demoRole();
      if (role === "read_only") {
        return { permissions: ["documents:read", "observations:read"], sourceDocumentAccessAllowed: false, redistributionAllowed: false, features };
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
    async listDocuments() {
      assertDemoModuleAvailable("documents");
      return demoCustomerJourneyStore.listDocuments();
    },
    async listObservations() {
      assertDemoModuleAvailable("observations");
      return demoCustomerJourneyStore.listObservations();
    },
    async listSnapshots() {
      assertDemoModuleAvailable("snapshots");
      return demoCustomerJourneyStore.listSnapshots();
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
