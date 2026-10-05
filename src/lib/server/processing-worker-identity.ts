import { createHash } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  PostgresMembershipAuthorizationRepository,
  type MembershipAuthorizationRepository,
} from "./authorization.ts";
import type { PostgresSqlApi } from "./postgres.ts";

export interface ServiceIdentityWorkspaceRepository {
  listActiveWorkspaces(input: { tenantId: string; subject: string }): Promise<string[]>;
}

export class PostgresServiceIdentityWorkspaceRepository implements ServiceIdentityWorkspaceRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async listActiveWorkspaces(input: { tenantId: string; subject: string }): Promise<string[]> {
    const rows = await this.db.query(`select distinct m.workspace_id::text as workspace_id
      from corvis_control.identity_subject s
      join corvis_control.membership m
        on m.tenant_id=s.tenant_id and m.user_id=s.user_id
      join corvis_control.workspace w
        on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id
      where s.tenant_id=$1::uuid
        and s.auth_method='service_account'
        and s.subject=$2
        and s.status='active'
        and m.status='active'
        and m.valid_from <= now()
        and (m.valid_until is null or m.valid_until > now())
        and w.status='active'
      order by m.workspace_id::text`, [input.tenantId, input.subject]);
    return rows.map((row) => row.workspace_id == null ? "" : String(row.workspace_id)).filter(Boolean);
  }
}

export function processingWorkerSessionId(subject: string): string {
  const digest = createHash("sha256").update(subject).digest("hex").slice(0, 32);
  return `processing-worker:${digest}`;
}

/**
 * Resolve the Google service-account subject back through the existing Corvis
 * membership/data-right/service-identity authorization repository. The transport
 * token never supplies application roles or document grants.
 *
 * A document must resolve to exactly one authorized workspace for this service
 * identity. Ambiguous or absent workspace authorization fails closed.
 */
export async function resolveProcessingWorkerIdentity(input: {
  tenantId: string;
  subject: string;
  documentId: string;
  workspaces: ServiceIdentityWorkspaceRepository;
  memberships: MembershipAuthorizationRepository;
}): Promise<RequestIdentity | undefined> {
  const sessionId = processingWorkerSessionId(input.subject);
  const workspaceIds = await input.workspaces.listActiveWorkspaces({ tenantId: input.tenantId, subject: input.subject });
  const matches: RequestIdentity[] = [];

  for (const workspaceId of workspaceIds) {
    const authorized = await input.memberships.resolve({
      subject: input.subject,
      tenantId: input.tenantId,
      workspaceId,
      authMethod: "service_account",
      sessionId,
    });
    if (!authorized || !authorized.documentIds.includes(input.documentId)) continue;
    matches.push({
      subject: input.subject,
      tenantId: input.tenantId,
      workspaceId,
      roles: authorized.roles,
      entitlements: {
        workspaceIds: authorized.workspaceIds,
        fundIds: authorized.fundIds,
        documentIds: authorized.documentIds,
        sourceDocumentIds: authorized.sourceDocumentIds,
        sourceDocumentAccessAllowed: authorized.sourceDocumentIds.length > 0,
        internalAnalyticsAllowed: authorized.internalAnalyticsAllowed,
        modelTrainingAllowed: authorized.modelTrainingAllowed,
        redistributionAllowed: authorized.redistributionAllowed,
      },
      authMethod: "service_account",
      sessionId,
    });
  }

  return matches.length === 1 ? matches[0] : undefined;
}

export function processingWorkerIdentityRepositories(db: PostgresSqlApi): {
  workspaces: ServiceIdentityWorkspaceRepository;
  memberships: MembershipAuthorizationRepository;
} {
  return {
    workspaces: new PostgresServiceIdentityWorkspaceRepository(db),
    memberships: new PostgresMembershipAuthorizationRepository(db),
  };
}
