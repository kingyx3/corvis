"use client";

import { useMemo, useSyncExternalStore } from "react";
import { latestRequestCorrelationId, subscribeRequestCorrelation } from "@/shared/lib/request-correlation";
import { currentSupportScope, subscribeSupportScope, type SupportScope } from "@/modules/support/domain/support-scope";
import { buildSupportRequest, supportConfigFromEnv, viewFromLocation, type SupportConfig, type SupportRequest } from "@/modules/support/domain/support";
import { workspaceContext } from "@/shared/lib/workspace-context";

const noSubscription = () => () => {};
// Server renders and the first client render both see `false`, so the browser-only context (storage, URL)
// is applied after hydration and never causes a markup mismatch in the error boundaries.
function useIsBrowser(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

const supportConfig = supportConfigFromEnv();

export function useSupportConfig(): SupportConfig {
  return supportConfig;
}

const noScope: SupportScope = {};

/**
 * The one way the UI obtains a "Contact support" action. The workspace is the one the shell last loaded
 * (falling back to the stored workspace selection), the view defaults to the URL hash, and the latest API
 * request id is followed live. Callers may pass what they know better: the active view, or the error
 * digest of the failure on screen.
 */
export function useSupportRequest(overrides: { view?: string; reference?: string } = {}): SupportRequest {
  const correlationId = useSyncExternalStore(subscribeRequestCorrelation, latestRequestCorrelationId, () => undefined);
  const scope = useSyncExternalStore(subscribeSupportScope, currentSupportScope, () => noScope);
  const browser = useIsBrowser();
  const { view, reference } = overrides;
  return useMemo(() => {
    const selection = browser ? workspaceContext() : null;
    return buildSupportRequest(supportConfig, {
      tenantId: scope.tenantId ?? selection?.tenantId,
      workspaceId: scope.workspaceId ?? selection?.workspaceId,
      view: view ?? (browser ? viewFromLocation(window.location) : undefined),
      reference,
      correlationId,
    });
  }, [browser, correlationId, reference, scope, view]);
}
