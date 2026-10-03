"use client";

import { useCallback, useEffect, useState } from "react";
import { reviewItemKey, type ReviewSubjectRef, type ReviewThreadSummary } from "@/core/review-discussion";
import { listReviewThreads, reviewDiscussionErrorMessage } from "@/features/review/discussion/api";

export type ReviewThreads = {
  /** `ready` once the workspace's assignments are known; assignee filters are only meaningful then. */
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  threadOf: (ref: ReviewSubjectRef) => ReviewThreadSummary | undefined;
  /** Records the outcome of an assignment or comment made in the dialog, so the row updates without a reload. */
  update: (summary: ReviewThreadSummary) => void;
  reload: () => void;
};

/**
 * The workspace's review-item threads (assignee, comment count) for Data review. A failure never blocks review: the
 * screen says assignments could not be loaded and turns the assignment filter off, since "Unassigned" would otherwise
 * show everything. `enabled` is false for a role that cannot review, which then never calls the API.
 */
export function useReviewThreads(enabled: boolean): ReviewThreads {
  const [threads, setThreads] = useState<ReadonlyMap<string, ReviewThreadSummary>>(() => new Map());
  const [state, setState] = useState<{ status: ReviewThreads["status"]; error?: string }>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void listReviewThreads(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setThreads(new Map(items.map((item) => [reviewItemKey(item), item])));
      setState({ status: "ready" });
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setState({ status: "error", error: reviewDiscussionErrorMessage(reason, "Assignments could not be loaded") });
    });
    return () => controller.abort();
  }, [enabled, reloadKey]);

  const threadOf = useCallback((ref: ReviewSubjectRef) => threads.get(reviewItemKey(ref)), [threads]);
  const update = useCallback((summary: ReviewThreadSummary) => setThreads((current) => new Map(current).set(reviewItemKey(summary), summary)), []);
  const reload = useCallback(() => { setState({ status: "loading" }); setReloadKey((key) => key + 1); }, []);
  return { status: enabled ? state.status : "idle", error: state.error, threadOf, update, reload };
}
