"use client";

import { useCallback, useEffect, useState } from "react";
import { unseenDataIssueUpdates } from "@/features/data-issues/api";

/**
 * How many of the signed-in person's reports changed status since they last looked, for the sidebar badge. A failure
 * (offline, signed out, role without access) simply shows no badge: the indicator is a convenience and must never
 * degrade the workspace. `refresh` re-reads it after the person acknowledges an update, and a change of `refreshOn` (the active view) re-reads it too.
 */
export function useDataIssueIndicator(enabled: boolean, refreshOn?: unknown): { unseen: number; refresh: () => void } {
  const [unseen, setUnseen] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void unseenDataIssueUpdates(controller.signal).then((count) => { if (!controller.signal.aborted) setUnseen(count); }).catch(() => undefined);
    return () => controller.abort();
  }, [enabled, reloadKey, refreshOn]);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);
  return { unseen: enabled ? unseen : 0, refresh };
}
