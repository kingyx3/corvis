import type { PlatformPort, ReadinessReport, ResearchAnswer, WorkspaceBootstrap } from "@/core/contracts";

type Options = { apiBase: string };

function join(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function request<T>(apiBase: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(join(apiBase, path), {
    ...init,
    credentials: "include",
    signal,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("Authentication required");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string; title?: string };
    throw new Error(payload.detail || payload.title || `Corvis API request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function createHttpPlatformPort(options: Options): PlatformPort {
  const apiBase = options.apiBase || "/api/v1";
  return {
    bootstrap: (signal) => request<WorkspaceBootstrap>(apiBase, "/bootstrap", {}, signal),
    ask: (question, signal) => request<ResearchAnswer>(apiBase, "/research", { method: "POST", body: JSON.stringify({ question }) }, signal),
    reviewObservation: (observationId, input, signal) => request<void>(apiBase, `/observations/${encodeURIComponent(observationId)}/review`, { method: "PATCH", body: JSON.stringify(input) }, signal),
    publishSnapshot: (snapshotId, signal) => request<void>(apiBase, `/snapshots/${encodeURIComponent(snapshotId)}/publish`, { method: "POST", body: "{}" }, signal),
    createExport: (snapshotId, format = "csv", signal) => request<{ url: string; sha256: string }>(apiBase, "/exports", { method: "POST", body: JSON.stringify({ snapshotId, format }) }, signal),
    openSource: (sourceReferenceId, signal) => request<{ documentUrl: string; page_number?: string | number; pageNumber?: number }>(apiBase, `/source-references/${encodeURIComponent(sourceReferenceId)}`, {}, signal),
    readiness: (signal) => request<ReadinessReport>(apiBase, "/admin/readiness", {}, signal),
  };
}
