import type { WorkspaceViewId } from "../../../shared/lib/view-hash.ts";

export type ResearchDraft = { question: string; key: number };

/**
 * A prefilled Ask Corvis question (from "Explain this exception") belongs to the single visit it
 * was created for. Any navigation away from Ask Corvis consumes it, so a later visit starts blank
 * instead of re-prefilling and autofocusing a stale question.
 */
export function researchDraftForView(draft: ResearchDraft | null, view: WorkspaceViewId): ResearchDraft | null {
  return view === "research" ? draft : null;
}
