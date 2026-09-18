import type { WorkspacePort, SourceEvidence } from "@/core/workspace";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";

type Envelope<T> = { data: T; correlationId: string };

export function createHttpWorkspacePort(apiBase = ""): WorkspacePort {
  const base = apiBase.replace(/\/$/, "");
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, credentials: "include", headers: { "content-type": "application/json", ...(init?.headers || {}) } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[] };
      throw new Error(body.reasons?.length ? `${body.error || "request_failed"}: ${body.reasons.join("; ")}` : body.error || `Corvis API request failed (${response.status})`);
    }
    const body = await response.json() as Envelope<T>;
    return body.data;
  }
  return {
    listDocuments: () => request<DocumentRecord[]>("/api/v1/documents"),
    listObservations: () => request<ObservationRecord[]>("/api/v1/observations"),
    listSnapshots: () => request<FundSnapshot[]>("/api/v1/snapshots"),
    research: (question: string) => request<ResearchAnswer>("/api/v1/research", { method: "POST", body: JSON.stringify({ question }) }),
    sourceEvidence: (sourceReferenceId: string) => request<SourceEvidence>(`/api/v1/source-references/${encodeURIComponent(sourceReferenceId)}`),
    review: async (command: ReviewDecision) => { await request("/api/v1/review", { method: "POST", body: JSON.stringify(command) }); },
    publish: async (command: SnapshotPublication) => { await request("/api/v1/snapshots/publish", { method: "POST", body: JSON.stringify(command) }); },
  };
}
