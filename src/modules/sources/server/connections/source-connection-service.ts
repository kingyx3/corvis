import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { demoSourceConnectionStore } from "../../adapters/source-connection-store.ts";
import { demoTestOutcome } from "../../adapters/source-providers.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { auditSourceConnectionEvent, createAuditedSourceConnection, reauthorizeAuditedSourceConnection, testAuditedSourceConnection, transitionAuditedSourceConnection } from "../connectors/source-connector-governance.ts";
import { sourceConnectorDrivers, sourceConnectorSecretStore } from "../connectors/source-connector-runtime.ts";
import { uploadIngestSink } from "../connectors/source-ingest-sink.ts";
import { approvedSourceProvider, credentialTypeOf, type ApprovedSourceProvider } from "../connectors/source-providers.ts";
import { ConflictError, platform } from "../../../../platform/data/platform.ts";
import { listSourceActivity, type SourceActivityConnection } from "../connectors/source-lifecycle.ts";
import {
  ConnectorGovernanceError,
  getSourceConnection,
  listSourceConnections,
  type ConnectorErrorClass,
  type SecretPayload,
  type SourceConnection,
  type SourceScope,
} from "../connectors/source-connectors.ts";
import { logEvent } from "../../../../platform/observability/telemetry.ts";

/** What a connectivity test tells the browser: pass or fail and a class for plain-language copy. Driver detail text never leaves the server. */
export type ConnectionTestOutcome = { ok: boolean; errorClass?: ConnectorErrorClass };

/** A newly created connection together with the result of the test that runs straight after authorization. */
export type ConnectResult = { connection: SourceConnection; test: ConnectionTestOutcome };

/** `scope` is what the connection reads when the administrator narrowed it (already validated against the provider, see resolveScopeSelection); omitted means everything the provider declares. */
export type ConnectInput = { provider: ApprovedSourceProvider; connectionLabel: string; secret: SecretPayload; scope?: SourceScope[] };

/** The scope a new connection is created with: the validated selection, else everything the provider declares, without the provider's internal ids. */
function connectionScope(provider: ApprovedSourceProvider, scope: SourceScope[] | undefined): SourceScope[] {
  return (scope ?? provider.scope).map(({ label, path }) => path ? { label, path } : { label });
}

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
  /**
   * Stores the credential an OAuth sign-in produced as the connection's new secret (the same rotation as `reauthorize`:
   * the previous secret is destroyed only after the new one is saved and audited) and runs the test straight away.
   * A failing test is reported with its class and moves the connection the way the test rules say.
   */
  reauthorizeAndTest(identity: RequestIdentity, sourceConnectionId: string, secret: SecretPayload, correlationId: string): Promise<ConnectResult>;
  /** A connectivity test on demand; never discovers or downloads a document. */
  test(identity: RequestIdentity, sourceConnectionId: string, correlationId: string): Promise<ConnectionTestOutcome>;
  /**
   * The duplicate-connection guard: refuses (`source_connection_already_exists`) when the workspace already has a live
   * (not revoked) connection to the provider. `connect` applies it too, so a sign-in that was started before the other
   * connection appeared still cannot create a second one. A revoked connection never blocks a new one.
   */
  assertNotConnected(identity: RequestIdentity, providerKey: string): Promise<void>;
  /** Records an OAuth sign-in started or declined: an event that changes no connection, in the access audit. */
  auditOAuth(identity: RequestIdentity, event: OAuthAuditEvent, correlationId: string): Promise<void>;
}

/** `targetId` is the connection being renewed, or the provider key when no connection exists yet. */
export type OAuthAuditEvent = { action: "source_connection.oauth_start" | "source_connection.oauth_declined"; targetId: string; providerKey: string };

async function assertNoLiveConnection(service: SourceConnectionService, identity: RequestIdentity, providerKey: string): Promise<void> {
  const connections = await service.list(identity);
  if (connections.some((connection) => connection.providerKey === providerKey && connection.status !== "revoked")) {
    throw new ConflictError("source_connection_already_exists");
  }
}

/**
 * The test that runs straight after a credential is stored (a new connection or a renewed authorization). An unexpected
 * fault is reported as a failed test rather than a failed request, since the credential is already saved. Only the
 * error's name is logged: never its message, which could echo a credential.
 */
async function testAfterAuthorization(identity: RequestIdentity, sourceConnectionId: string, correlationId: string): Promise<ConnectionTestOutcome> {
  try {
    return await postgresSourceConnectionService.test(identity, sourceConnectionId, correlationId);
  } catch (error) {
    logEvent("error", "source_connection.initial_test_failed", { correlationId }, { errorName: error instanceof Error ? error.name : "unknown" });
    return { ok: false, errorClass: "network" };
  }
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
  async connect(identity, { provider, connectionLabel, secret, scope }, correlationId) {
    await postgresSourceConnectionService.assertNotConnected(identity, provider.providerKey);
    const created = await createAuditedSourceConnection(identity, {
      workspaceId: identity.workspaceId,
      providerKey: provider.providerKey,
      connectionLabel,
      credentialType: credentialTypeOf(provider),
      sourceScope: connectionScope(provider, scope),
      secret,
      connectorVersion: provider.connectorVersion,
    }, correlationId, { secrets: sourceConnectorSecretStore() });
    const test = await testAfterAuthorization(identity, created.sourceConnectionId, correlationId);
    return { connection: await postgresSourceConnectionService.get(identity, created.sourceConnectionId), test };
  },
  async reauthorizeAndTest(identity, sourceConnectionId, secret, correlationId) {
    await postgresSourceConnectionService.reauthorize(identity, sourceConnectionId, secret, correlationId);
    const test = await testAfterAuthorization(identity, sourceConnectionId, correlationId);
    return { connection: await postgresSourceConnectionService.get(identity, sourceConnectionId), test };
  },
  async test(identity, sourceConnectionId, correlationId) {
    return outcomeOf(await testAuditedSourceConnection(identity, sourceConnectionId, correlationId, {
      secrets: sourceConnectorSecretStore(),
      drivers: sourceConnectorDrivers(),
      oauthClient: (providerKey) => approvedSourceProvider(providerKey)?.oauth,
    }));
  },
  assertNotConnected(identity, providerKey) { return assertNoLiveConnection(postgresSourceConnectionService, identity, providerKey); },
  auditOAuth(identity, event, correlationId) {
    return auditSourceConnectionEvent(identity, correlationId, event.action, event.targetId, { providerKey: event.providerKey });
  },
};

/**
 * Demo mode has no scheduler process, so a workspace's due demo connections are collected when its connections or run
 * history are read: the same loop the delivery tick runs in production, over the in-memory store (demo mode only).
 */
async function collectDemoDue(identity: RequestIdentity): Promise<void> {
  await demoSourceConnectionStore().runDueSyncs({ ingest: uploadIngestSink(), identity });
}

export const demoSourceConnectionService: SourceConnectionService = {
  async list(identity) { await collectDemoDue(identity); return demoSourceConnectionStore().list(identity); },
  async get(identity, sourceConnectionId) { return demoSourceConnectionStore().get(identity, sourceConnectionId); },
  async transition(identity, sourceConnectionId, action) { return demoSourceConnectionStore().transition(identity, sourceConnectionId, action); },
  async reauthorize(identity, sourceConnectionId) { return demoSourceConnectionStore().reauthorize(identity, sourceConnectionId); },
  async activity(identity) { await collectDemoDue(identity); return demoSourceConnectionStore().activity(identity); },
  async connect(identity, { provider, connectionLabel, secret, scope }) {
    await demoSourceConnectionService.assertNotConnected(identity, provider.providerKey);
    const store = demoSourceConnectionStore();
    // Only the non-secret test outcome is kept; the credential is dropped here, never stored.
    const created = store.create(identity, {
      providerKey: provider.providerKey,
      connectionLabel,
      credentialType: credentialTypeOf(provider),
      scope: connectionScope(provider, scope),
      connectorVersion: provider.connectorVersion,
      testOutcome: demoTestOutcome(provider.providerKey, secret),
    });
    const test = store.test(identity, created.sourceConnectionId);
    return { connection: store.get(identity, created.sourceConnectionId), test };
  },
  async reauthorizeAndTest(identity, sourceConnectionId) {
    const store = demoSourceConnectionStore();
    store.reauthorize(identity, sourceConnectionId);
    const test = store.test(identity, sourceConnectionId);
    return { connection: store.get(identity, sourceConnectionId), test: outcomeOf(test) };
  },
  async test(identity, sourceConnectionId) { return outcomeOf(demoSourceConnectionStore().test(identity, sourceConnectionId)); },
  assertNotConnected(identity, providerKey) { return assertNoLiveConnection(demoSourceConnectionService, identity, providerKey); },
  async auditOAuth(identity, event, correlationId) {
    // Demo mode keeps its audit in memory, like every other demo mutation: not production evidence.
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: event.action, targetType: "source_connection",
      targetId: event.targetId, outcome: "success", correlationId, metadata: { providerKey: event.providerKey },
    });
  },
};

let override: SourceConnectionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideSourceConnectionService(service?: SourceConnectionService): void { override = service; }

export function sourceConnectionService(): SourceConnectionService {
  return override ?? (getServerConfig().demoMode ? demoSourceConnectionService : postgresSourceConnectionService);
}
