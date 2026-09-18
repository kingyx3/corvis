import type { PlatformPort, WorkspaceBootstrap } from "@/core/contracts";
import { documents, fundSnapshots, observations, recentActivity, researchSuggestions } from "@/adapters/demo/catalog";

const bootstrap: WorkspaceBootstrap = {
  session: { name: "Alex Morgan", email: "demo@corvis.local", tenantId: "tenant_demo_northbridge", workspaceName: "Northbridge Partners", roles: ["admin"] },
  documents,
  observations: observations.map((row, index) => ({ ...row, sourceReferenceId: `src_demo_${index + 1}`, snapshotId: "fps_adv8_2026q2_v2" })),
  fundSnapshots: fundSnapshots.map((snapshot, index) => ({ ...snapshot, id: index === 0 ? "fps_adv8_2026q2_v2" : `fps_demo_${index + 1}` })),
  recentActivity,
  researchSuggestions,
  featureFlags: { research: true, exports: true, review: true, administration: true },
};

export function createDemoPlatformPort(): PlatformPort {
  return {
    async bootstrap() { return structuredClone(bootstrap); },
    async ask(question) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return {
        answer: `Demo mode: “${question}” would be answered from governed semantic measures and permission-filtered source evidence in production. The sample Q2 dataset shows ABC Corp Adjusted EBITDA at $125m with revenue growth of 12.1%.`,
        citations: [
          { type: "source", id: "src_demo_1", label: "Advent VIII · Q2 · p.18", pageNumber: 18 },
          { type: "snapshot", id: "fps_adv8_2026q2_v2", label: "Fund-period snapshot fps_adv8_2026q2_v2" },
        ],
        toolTrace: [{ tool: "semantic_query", resultCount: 3 }, { tool: "document_search", resultCount: 2 }],
      };
    },
    async reviewObservation() { return; },
    async publishSnapshot() { return; },
    async createExport() {
      const csv = '"company","metric","value"\n"ABC Corp","Adjusted EBITDA","$125m"\n';
      return { url: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), sha256: "demo" };
    },
    async openSource(sourceReferenceId) { return { documentUrl: `about:blank#${sourceReferenceId}`, pageNumber: 18 }; },
    async readiness() {
      return {
        environment: "development",
        demoMode: true,
        tenantId: "tenant_demo_northbridge",
        controls: [
          { id: "auth", status: "demo", detail: "Production uses OIDC" },
          { id: "storage", status: "demo", detail: "Production uses quarantined multipart object storage" },
          { id: "search", status: "demo", detail: "Production uses tenant-filtered Cortex Search" },
        ],
      };
    },
  };
}
