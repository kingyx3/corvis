import type { RequestIdentity } from "../../core/enterprise.ts";
import { demoSourceConnectionStore } from "../../adapters/demo/source-connection-store.ts";
import { demoTestOutcome } from "../../adapters/demo/source-providers.ts";
import { getServerConfig } from "./config.ts";
import { createAuditedSourceConnection, reauthorizeAuditedSourceConnection, testAuditedSourceConnection, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
import { sourceConnectorDrivers, sourceConnectorSecretStore } from "./source-connector-runtime.ts";
import { credentialTypeOf, type ApprovedSourceProvider } from "./source-providers.ts";
import { listSourceActivity, type SourceActivityConnection } from "./source-lifecycle.ts";
import {
  ConnectorGovernanceError,
  getSourceConnection,
  listSourceConnections,
  type ConnectorErrorClass,
  type SecretPayload,
  type SourceConnection,
} from "./source-connectors.ts";
import { logEvent } from "./telemetry.ts";

/** What a connectivity test tells the browser: pass or fail and a class for plain-language copy. Driver detail text never leaves the server. */
export type ConnectionTestOutcome = { ok: boolean; errorClass?: ConnectorErrorClass };

/** A newly created connection together with the result of the test that runs straight after authorization. */
export type ConnectResult = { connection: SourceConnection; test: ConnectionTestOutcome };

export type ConnectInput = { provider: ApprovedSourceProvider; connectionLabel: string; secret: SecretPayload };

function outcomeOf(result: { ok: boolean; errorClass?: ConnectorErrorClass }): ConnectionTestOutcome {
  return result.ok ? { ok: true } : { ok: false, ...(result.errorClass ? { errorClass: result.errorClass } : {}) };
}

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
  /**
   * Creates a connection for an approved provider (scope and credential type come from the provider, never from the caller)
   * and immediately runs its first connectivity test. Only a passing test activates it, so a failure leaves scheduled sync blocked.
   */
  connect(identity: RequestIdentity, input: ConnectInput, correlationId: string): Promise<ConnectResult>;
  /** A connectivity test on demand; never discovers or downloads a document. */
  test(identity: RequestIdentity, sourceConnectionId: string, correlationId: string): Promise<ConnectionTestOutcome>;
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
  async connect(identity, { provider, connectionLabel, secret }, correlationId) {
    const created = await createAuditedSourceConnection(identity, {
      workspaceId: identity.workspaceId,
      providerKey: provider.providerKey,
      connectionLabel,
      credentialType: credentialTypeOf(provider),
      sourceScope: provider.scope.map((item) => ({ ...item })),
      secret,
      connectorVersion: provider.connectorVersion,
    }, correlationId, { secrets: sourceConnectorSecretStore() });
    let test: ConnectionTestOutcome;
    try {
      test = await postgresSourceConnectionService.test(identity, created.sourceConnectionId, correlationId);
    } catch (error) {
      // The connection exists and stays pending (so nothing is collected); an unexpected fault is reported as a failed
      // test rather than a failed connect. Only the error's name is logged: never its message, which could echo a credential.
      logEvent("error", "source_connection.initial_test_failed", { correlationId }, { errorName: error instanceof Error ? error.name : "unknown" });
      test = { ok: false, errorClass: "network" };
    }
    return { connection: await postgresSourceConnectionService.get(identity, created.sourceConnectionId), test };
  },
  async test(identity, sourceConnectionId, correlationId) {
    return outcomeOf(await testAuditedSourceConnection(identity, sourceConnectionId, correlationId, {
      secrets: sourceConnectorSecretStore(),
      drivers: sourceConnectorDrivers(),
    }));
  },
};

export const demoSourceConnectionService: SourceConnectionService = {
  async list(identity) { return demoSourceConnectionStore().list(identity); },
  async get(identity, sourceConnectionId) { return demoSourceConnectionStore().get(identity, sourceConnectionId); },
  async transition(identity, sourceConnectionId, action) { return demoSourceConnectionStore().transition(identity, sourceConnectionId, action); },
  async reauthorize(identity, sourceConnectionId) { return demoSourceConnectionStore().reauthorize(identity, sourceConnectionId); },
  async activity(identity) { return demoSourceConnectionStore().activity(identity); },
  async connect(identity, { provider, connectionLabel, secret }) {
    const store = demoSourceConnectionStore();
    // Only the non-secret test outcome is kept; the credential is dropped here, never stored.
    const created = store.create(identity, {
      providerKey: provider.providerKey,
      connectionLabel,
      credentialType: credentialTypeOf(provider),
      scope: provider.scope,
      connectorVersion: provider.connectorVersion,
      testOutcome: demoTestOutcome(provider.providerKey, secret),
    });
    const test = store.test(identity, created.sourceConnectionId);
    return { connection: store.get(identity, created.sourceConnectionId), test };
  },
  async test(identity, sourceConnectionId) { return outcomeOf(demoSourceConnectionStore().test(identity, sourceConnectionId)); },
};

let override: SourceConnectionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideSourceConnectionService(service?: SourceConnectionService): void { override = service; }

export function sourceConnectionService(): SourceConnectionService {
  return override ?? (getServerConfig().demoMode ? demoSourceConnectionService : postgresSourceConnectionService);
}
