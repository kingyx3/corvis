import type {
  CreateServiceAccountCommand,
  IssuedServiceAccountCredential,
  ServiceAccount,
  ServiceAccountCommand,
  ServiceAccountList,
} from "@/core/service-account";
import { apiUrl } from "@/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/lib/api-errors";
import { workspaceContextHeaders } from "@/lib/workspace-context";

const SERVICE_ACCOUNTS = "/api/v1/access/service-accounts";

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

/** Plain-language copy for the stable error codes the service-account routes return; anything else gets `fallback`. */
export function serviceAccountErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  const known: Record<string, string> = {
    tenant_admin_required: "Only an Organization Admin can manage service accounts.",
    invalid_name: "Give the service account a name of 3 to 120 characters, on one line.",
    invalid_purpose: "Say what the service account is for, in 3 to 512 characters, on one line.",
    invalid_role: "Choose Review Analyst, Analyst or Viewer. A service account is never an administrator.",
    invalid_workspace: "Choose one of your workspaces.",
    invalid_expiry: "Enter 1 to 365 days. To extend an account, the new expiry must be later than the current one.",
    invalid_owner: "Choose the Organization Admin who will own this account.",
    invalid_overlap: "The overlap can be 0 minutes to 24 hours.",
    invalid_reason: "Add a short reason (3 to 1,000 characters on one line). It is kept in the audit trail.",
    workspace_not_found: "That workspace is not available. Refresh the page and choose another.",
    service_account_name_in_use: "Another active service account already has this name.",
    service_account_limit_reached: "Your organization has reached its limit of 100 active service accounts. Deactivate one you no longer use.",
    service_account_not_found: "This service account is no longer available.",
    service_account_not_active: "This service account is deactivated or has expired, so it cannot be changed. Create a new one if you still need it.",
    service_account_credential_exists: "This service account already has a credential. Rotate it instead.",
    service_account_no_active_credential: "This service account has no credential in use. Issue one first.",
    service_account_needs_owner: "This account has no active owner, so it is not extended. Assign a new owner first, then extend it.",
    service_account_owner_invalid: "The new owner must be an active Organization Admin of your organization. Refresh the page and choose again.",
    service_account_owner_unchanged: "That person already owns this account. Choose someone else.",
  };
  return typeof code === "string" && known[code] ? known[code]! : friendlyErrorMessage(reason, fallback);
}

export async function listServiceAccounts(signal?: AbortSignal): Promise<ServiceAccountList> {
  return (await (await send(SERVICE_ACCOUNTS, { signal })).json() as { data: ServiceAccountList }).data;
}

/** The only response that carries a secret: the caller must show it once and keep it nowhere else. */
export async function createServiceAccount(command: Pick<CreateServiceAccountCommand, "name" | "purpose" | "workspaceId" | "roleName" | "expiresInDays" | "credentialExpiresInDays">): Promise<{ serviceAccount: ServiceAccount; credential: IssuedServiceAccountCredential }> {
  return (await (await send(SERVICE_ACCOUNTS, { method: "POST", body: JSON.stringify(command) })).json() as { data: { serviceAccount: ServiceAccount; credential: IssuedServiceAccountCredential } }).data;
}

export async function actOnServiceAccount(serviceAccountId: string, command: ServiceAccountCommand): Promise<{ serviceAccount: ServiceAccount; credential?: IssuedServiceAccountCredential }> {
  return (await (await send(`${SERVICE_ACCOUNTS}/${encodeURIComponent(serviceAccountId)}`, { method: "POST", body: JSON.stringify(command) })).json() as { data: { serviceAccount: ServiceAccount; credential?: IssuedServiceAccountCredential } }).data;
}
