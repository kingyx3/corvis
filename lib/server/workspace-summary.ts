import { hasPermission, type RequestIdentity } from "../../core/enterprise.ts";
import { buildWorkspaceSummary, type SourceHealthInput, type WorkspaceSummary } from "../../core/workspace-summary.ts";
import { getServerConfig } from "./config.ts";
import { platform as defaultPlatform, type PlatformPort } from "./platform.ts";
import { listSourceConnections } from "./source-connectors.ts";

export type WorkspaceSummaryDependencies = {
  platform?: PlatformPort;
  sources?: (identity: RequestIdentity) => Promise<SourceHealthInput[]>;
  now?: Date;
};

/**
 * Source-connection health is workspace configuration, so it only joins the
 * attention surface for callers who can already see it on /source-connections
 * (admin:manage), scoped to their own workspace exactly as that route is.
 */
async function workspaceSourceHealth(identity: RequestIdentity): Promise<SourceHealthInput[]> {
  if (getServerConfig().demoMode) return [];
  const connections = await listSourceConnections(identity);
  return connections
    .filter((connection) => connection.workspaceId === identity.workspaceId && connection.status !== "revoked")
    .map((connection) => ({
      sourceConnectionId: connection.sourceConnectionId,
      connectionLabel: connection.connectionLabel,
      status: connection.status,
      consecutiveFailures: connection.consecutiveFailures,
      lastErrorClass: connection.lastErrorClass,
      lastSuccessAt: connection.lastSuccessAt,
    }));
}

/**
 * Composes the Overview summary from the same entitlement-scoped reads the
 * Documents, Data review and snapshot screens use, so every count reconciles
 * with the screen its attention item links to. The caller must already hold
 * observations:read.
 */
export async function workspaceSummary(identity: RequestIdentity, dependencies: WorkspaceSummaryDependencies = {}): Promise<WorkspaceSummary> {
  const port = dependencies.platform ?? defaultPlatform();
  const [snapshots, observations, documents, valueFacts, dimensionFacts, sources] = await Promise.all([
    port.listSnapshots(identity),
    port.listObservations(identity),
    hasPermission(identity, "documents:read") ? port.listDocuments(identity) : Promise.resolve([]),
    port.portfolioValueFacts(identity),
    port.exposureDimensionFacts(identity),
    hasPermission(identity, "admin:manage") ? (dependencies.sources ?? workspaceSourceHealth)(identity) : Promise.resolve(undefined),
  ]);
  return buildWorkspaceSummary({ snapshots, observations, documents, valueFacts, dimensionFacts, sources, now: dependencies.now ?? new Date() });
}
