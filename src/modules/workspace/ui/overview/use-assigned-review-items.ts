"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssignedReviewItem } from "@/modules/review/domain/review-discussion";
import { listAssignedReviewItems, reviewDiscussionErrorMessage } from "@/modules/review/ui/discussion/api";

export type AssignedReviewItems = { status: "idle" | "loading" | "ready" | "error"; items: AssignedReviewItem[]; error?: string; reload: () => void };

/**
 * The signed-in reviewer's own open assignments, for the Overview attention list's "Assigned to me" view (F3). A failure
 * is reported in that view only: the rest of the attention list never depends on it. `refreshOn` re-reads it when the
 * Overview summary is refreshed. `enabled` is false for a role that cannot review, which then never calls the API.
 */
export function useAssignedReviewItems(enabled: boolean, refreshOn?: unknown): AssignedReviewItems {
  const [state, setState] = useState<{ status: AssignedReviewItems["status"]; items: AssignedReviewItem[]; error?: string }>({ status: "idle", items: [] });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void listAssignedReviewItems(controller.signal).then((items) => {
      if (!controller.signal.aborted) setState({ status: "ready", items });
    }).catch((reason) => {
      if (!controller.signal.aborted) setState({ status: "error", items: [], error: reviewDiscussionErrorMessage(reason, "Your assigned items could not be loaded") });
    });
    return () => controller.abort();
  }, [enabled, refreshOn, reloadKey]);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return { ...(enabled ? state : { status: "idle" as const, items: [] }), reload };
}
