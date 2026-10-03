import type { SessionPolicy, SessionPolicyView, SignOutEverywhereResult } from "@/core/session-policy";
import { apiUrl } from "@/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/lib/api-errors";
import { workspaceContextHeaders } from "@/lib/workspace-context";

const POLICY = "/api/v1/access/session-policy";

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { ...workspaceContextHeaders(), accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (!response.ok) throw await apiResponseError(response);
  return response;
}

/** Plain-language copy for the stable error codes the session policy routes return; anything else gets `fallback`. */
export function sessionPolicyErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  const known: Record<string, string> = {
    tenant_admin_required: "Only an Organization Admin can do this.",
    invalid_idle_timeout: "The idle timeout must be a whole number of minutes within the allowed range, or no limit.",
    invalid_max_session: "The maximum session length must be a whole number of minutes within the allowed range, or no limit.",
    idle_exceeds_max_session: "The idle timeout cannot be longer than the maximum session length.",
    session_policy_out_of_bounds: "That value is outside the limits Corvis allows.",
    invalid_reason: "Say why you are making this change, in 3 to 1,000 characters.",
    session_policy_version_conflict: "Another Organization Admin changed this policy while you were editing. The latest values are shown; review them and try again.",
    session_not_measurable: "Your identity provider does not send a stable session id, so session limits cannot be applied: every session would be refused. Ask Corvis support to enable session ids for your sign-in.",
    cannot_sign_out_current_user: "You cannot sign yourself out here. Sign out from your own session instead.",
    member_not_found: "This person is no longer an active member of your organization.",
  };
  return typeof code === "string" && known[code] ? known[code]! : friendlyErrorMessage(reason, fallback);
}

export async function getSessionPolicy(signal?: AbortSignal): Promise<SessionPolicyView> {
  return (await (await send(POLICY, { signal })).json() as { data: SessionPolicyView }).data;
}

export async function saveSessionPolicy(change: { idleTimeoutMinutes: number | null; maxSessionMinutes: number | null; expectedVersion: number; reason: string }): Promise<SessionPolicy> {
  return (await (await send(POLICY, { method: "PUT", body: JSON.stringify(change) })).json() as { data: SessionPolicy }).data;
}

export async function signOutEverywhere(userId: string, reason: string): Promise<SignOutEverywhereResult> {
  return (await (await send(`${POLICY}/sign-out`, { method: "POST", body: JSON.stringify({ userId, reason }) })).json() as { data: SignOutEverywhereResult }).data;
}
