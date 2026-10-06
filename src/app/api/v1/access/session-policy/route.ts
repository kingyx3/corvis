import { parseSessionPolicyUpdate } from "@/modules/identity-access/domain/session-policy";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { resolveOrganizationAdmin } from "@/modules/governance/server/lifecycle/data-governance";
import { correlationId, json } from "@/platform/http/api/http";
import { sessionPolicyErrorResponse, sessionPolicyService } from "@/modules/identity-access/server/sessions/session-policy";

/**
 * The organization's sign-in setup and session policy (F7, #263): the configured identity provider, SCIM status, the
 * sign-in methods in use, the idle timeout and maximum session length with the Corvis bounds they must stay within,
 * and each person's active sessions. Organization-Admin-only. Initial identity-provider setup stays Corvis-assisted,
 * so everything about the provider is read-only here.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    return json({ data: await sessionPolicyService().view(identity), correlationId: id });
  } catch (error) { return sessionPolicyErrorResponse(error, id); }
}

/**
 * Sets the idle timeout and maximum session length, each within the Corvis bounds or `null` for no limit. The body
 * states both limits, the `expectedVersion` it is based on and a `reason`. The change is audited and every
 * Organization Admin is sent a security notice.
 */
export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const command = parseSessionPolicyUpdate(await readJsonObject(request));
    return json({ data: await sessionPolicyService().update(identity, command, id), correlationId: id });
  } catch (error) { return sessionPolicyErrorResponse(error, id); }
}
