import { parseSignOutEverywhere } from "@/modules/identity-access/domain/session-policy";
import { readJsonObject } from "@/platform/http/admin-request";
import { resolveOrganizationAdmin } from "@/modules/governance/server/data-governance";
import { correlationId, json } from "@/platform/http/http";
import { sessionPolicyErrorResponse, sessionPolicyService } from "@/modules/identity-access/server/session-policy";

/**
 * "Sign out everywhere" for a named user (F7, #263): revokes every session Corvis has seen for that person, effective on
 * their next request. Body `{ userId, reason }`. The person can sign in again (a new sign-in is a new session);
 * removing their access is a separate action. Audited, and every Organization Admin is sent a security notice. An
 * Organization Admin cannot sign themselves out here (`409 cannot_sign_out_current_user`).
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const command = parseSignOutEverywhere(await readJsonObject(request));
    return json({ data: await sessionPolicyService().signOut(identity, command, id), correlationId: id });
  } catch (error) { return sessionPolicyErrorResponse(error, id); }
}
