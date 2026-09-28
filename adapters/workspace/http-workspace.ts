import { workspaceContextHeaders } from "../../lib/workspace-context.ts";
import type {
  MemberRoleReceipt,
  DeactivateTenantAccessResult,
  TenantInvitation,
  TenantInvitationCreated,
  TenantAccessMember,
  WorkspaceCapabilities,
  WorkspaceIdentity,
  WorkspacePort,
  SourceEvidence,
} from "@/core/workspace";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { WorkspaceSummary } from "@/core/workspace-summary";
import type { CompanySectorAssignment, CompanySectorAssignmentOutcome, CompanySectorRecord } from "@/core/sector-taxonomy";
import type {
  ReconciliationException,
  ReconciliationResolutionCommand,
  ReconciliationResolutionOutcome,
  ResearchAnswer,
  ResearchPin,
  ResearchStreamEvent,
  ReviewDecision,
  ReviewOutcome,
  SnapshotPublication,
  WorkspaceMembershipSummary,
} from "@/core/enterprise";

type Envelope<T> = { data: T; correlationId: string };
type CollectionEnvelope<T> = Envelope<T[]> & { nextCursor: string | null };

export function createHttpWorkspacePort(apiBase = ""): WorkspacePort {
  const base = apiBase.replace(/\/$/, "");

  async function responseError(response: Response): Promise<Error> {
    const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[] };
    return new Error(body.reasons?.length
      ? `${body.error || "request_failed"}: ${body.reasons.join("; ")}`
      : body.error || `Corvis API request failed (${response.status})`);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, credentials: "include", headers: { "content-type": "application/json", ...workspaceContextHeaders(), ...(init?.headers || {}) } });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as Envelope<T>;
    return body.data;
  }

  /**
   * First-party collection reads always use the published cursor contract.
   * The server still preserves its no-query compatibility mode for older
   * external v1 consumers, but Corvis itself must not depend on that branch.
   */
  async function requestCollection<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${base}${path}?${query.toString()}`, {
        credentials: "include",
        headers: { "content-type": "application/json", ...workspaceContextHeaders() },
      });
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as CollectionEnvelope<T>;
      items.push(...body.data);
      if (body.nextCursor && seen.has(body.nextCursor)) throw new Error("pagination_cursor_cycle");
      cursor = body.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  async function researchStream(
    question: string,
    onEvent: (event: ResearchStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ResearchAnswer> {
    const response = await fetch(`${base}/api/v1/research/stream`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/x-ndjson", ...workspaceContextHeaders() },
      body: JSON.stringify({ question }),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error("research_stream_unavailable");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer: ResearchAnswer | undefined;

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ResearchStreamEvent;
      onEvent(event);
      if (event.type === "result") answer = event.data;
      if (event.type === "error") throw new Error(event.code);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer.trim()) consumeLine(buffer);
      if (!answer) throw new Error("research_stream_ended_without_result");
      return answer;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    changeMemberRole: (command) => request<MemberRoleReceipt>("/api/v1/access/members/role", { method: "POST", body: JSON.stringify(command) }),
    capabilities: () => request<WorkspaceCapabilities>("/api/v1/capabilities"),
    whoAmI: () => request<WorkspaceIdentity>("/api/v1/me"),
    listMyWorkspaces: () => request<WorkspaceMembershipSummary[]>("/api/v1/my-workspaces"),
    listDocuments: () => requestCollection<DocumentRecord>("/api/v1/documents"),
    listObservations: () => requestCollection<ObservationRecord>("/api/v1/observations"),
    listSnapshots: () => requestCollection<FundSnapshot>("/api/v1/snapshots"),
    workspaceSummary: () => request<WorkspaceSummary>("/api/v1/workspace-summary"),
    listCompanySectors: () => request<CompanySectorRecord[]>("/api/v1/company-sectors"),
    assignCompanySector: (command: CompanySectorAssignment) => request<CompanySectorAssignmentOutcome>("/api/v1/company-sectors", { method: "POST", body: JSON.stringify({ ...command, idempotencyKey: crypto.randomUUID() }) }),
    listAccessMembers: () => request<TenantAccessMember[]>("/api/v1/access/members"),
    deactivateAccessMember: (command) => request<DeactivateTenantAccessResult>("/api/v1/access/members/deactivate", {
      method: "POST",
      body: JSON.stringify(command),
    }),
    createAccessInvitation: (command) => request<TenantInvitationCreated>("/api/v1/access/invitations", {
      method: "POST", body: JSON.stringify(command),
    }),
    listAccessInvitations: () => request<TenantInvitation[]>("/api/v1/access/invitations"),
    listReconciliationExceptions: (snapshotId: string, snapshotVersion: number) => request<ReconciliationException[]>(
      `/api/v1/reconciliation-exceptions?snapshotId=${encodeURIComponent(snapshotId)}&snapshotVersion=${snapshotVersion}`,
    ),
    research: (question: string, signal?: AbortSignal) => request<ResearchAnswer>("/api/v1/research", { method: "POST", body: JSON.stringify({ question }), signal }),
    researchStream,
    listResearchPins: () => request<ResearchPin[]>("/api/v1/research/pins"),
    pinResearchAnswer: (command) => request<ResearchPin>("/api/v1/research/pins", { method: "POST", body: JSON.stringify(command) }),
    unpinResearchAnswer: async (pinId: string) => { await request(`/api/v1/research/pins/${encodeURIComponent(pinId)}`, { method: "DELETE" }); },
    sourceEvidence: (sourceReferenceId: string) => request<SourceEvidence>(`/api/v1/source-references/${encodeURIComponent(sourceReferenceId)}`),
    review: (command: ReviewDecision) => request<ReviewOutcome>("/api/v1/review", { method: "POST", body: JSON.stringify(command) }),
    resolveReconciliation: (command: ReconciliationResolutionCommand) => request<ReconciliationResolutionOutcome>(
      "/api/v1/reconciliation-exceptions/resolve",
      { method: "POST", body: JSON.stringify(command) },
    ),
    publish: async (command: SnapshotPublication) => { await request("/api/v1/snapshots/publish", { method: "POST", body: JSON.stringify(command) }); },
  };
}
