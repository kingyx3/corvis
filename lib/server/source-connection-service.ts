import type { RequestIdentity } from "../../core/enterprise.ts";
import { demoSourceConnectionStore } from "../../adapters/demo/source-connection-store.ts";
import { getServerConfig } from "./config.ts";
import { reauthorizeAuditedSourceConnection, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
import { sourceConnectorSecretStore } from "./source-connector-runtime.ts";
import { listSourceActivity, type SourceActivityConnection } from "./source-lifecycle.ts";
import {
  ConnectorGovernanceError,
  getSourceConnection,
  listSourceConnections,
  type SecretPayload,
  type SourceConnection,
} from "./source-connectors.ts";

/**
 * The customer-facing source-connection operations behind
 * `/api/v1/source-connections/**`, with one implementation backed by Postgres
 * and one by the in-memory demo store (demo mode only; production refuses
 * `CORVIS_DEMO_MODE`). Routes stay thin authorization/validation adapters and
 * never branch on the backend themselves. Both implementations enforce the
 * workspace boundary and return connections that still carry a redacted
 * `secretReference`, which the route strips before responding.
 */
export interface SourceConnectionService {
  list(identity: RequestIdentity): Promise<SourceConnection[]>;
  get(identity: RequestIdentity, sourceConnectionId: string): Promise<SourceConnection>;
  transition(identity: RequestIdentity, sourceConnectionId: string, action: "pause" | "resume" | "revoke", correlationId: string): Promise<SourceConnection>;
  reauthorize(identity: RequestIdentity, sourceConnectionId: string, secret: SecretPayload, correlationId: string): Promise<SourceConnection>;
  activity(identity: RequestIdentity): Promise<SourceActivityConnection[]>;
}

export const postgresSourceConnectionService: SourceConnectionService = {
  async list(identity) {
    // `accountadmin` is workspace-scoped while the repository listing is tenant-scoped, so the workspace
    // boundary is enforced here before any row leaves the service.
    const connections = await listSourceConnections(identity);
    return connections.filter((connection) => connection.workspaceId === identity.workspaceId);
  },
  async get(identity, sourceConnectionId) {
    const connection = await getSourceConnection(identity, sourceConnectionId);
    if (connection.workspaceId !== identity.workspaceId) throw new ConnectorGovernanceError("connection_not_found");
    return connection;
  },
  transition(identity, sourceConnectionId, action, correlationId) {
    return transitionAuditedSourceConnection(identity, sourceConnectionId, action, correlationId, { secrets: sourceConnectorSecretStore() });
  },
  reauthorize(identity, sourceConnectionId, secret, correlationId) {
    return reauthorizeAuditedSourceConnection(identity, sourceConnectionId, secret, correlationId, { secrets: sourceConnectorSecretStore() });
  },
  activity(identity) {
    return listSourceActivity(identity);
  },
};

export const demoSourceConnectionService: SourceConnectionService = {
  async list(identity) { return demoSourceConnectionStore().list(identity); },
  async get(identity, sourceConnectionId) { return demoSourceConnectionStore().get(identity, sourceConnectionId); },
  async transition(identity, sourceConnectionId, action) { return demoSourceConnectionStore().transition(identity, sourceConnectionId, action); },
  async reauthorize(identity, sourceConnectionId) { return demoSourceConnectionStore().reauthorize(identity, sourceConnectionId); },
  async activity(identity) { return demoSourceConnectionStore().activity(identity); },
};

let override: SourceConnectionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideSourceConnectionService(service?: SourceConnectionService): void { override = service; }

export function sourceConnectionService(): SourceConnectionService {
  return override ?? (getServerConfig().demoMode ? demoSourceConnectionService : postgresSourceConnectionService);
}
