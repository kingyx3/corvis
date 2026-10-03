import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PostgresSqlApi } from "./postgres.ts";

/**
 * The service-account credential secret (F6, #262): how it is minted, what is stored, and how a presented secret is
 * checked against the stored record.
 *
 * A secret is `corvis_sa_<credential id, 32 hex>_<256 random bits, base64url>`. The embedded credential id only
 * selects the stored record (it is not secret); the 256 random bits are the credential. Only the SHA-256 of the whole
 * secret is stored: with that much entropy a fast hash resists guessing as well as a slow one, and it is what the
 * invitation and export-link tokens already use. The secret is returned to the creating admin once and never again.
 */

const SECRET_PATTERN = /^corvis_sa_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export type MintedCredential = { credentialId: string; secret: string; secretSha256: string };

export function hashCredentialSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function mintCredential(): MintedCredential {
  const credentialId = randomUUID();
  const secret = `corvis_sa_${credentialId.replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
  return { credentialId, secret, secretSha256: hashCredentialSecret(secret) };
}

/** The credential id a well-formed secret names, or null. Never throws and never reveals why a secret was refused. */
export function credentialIdOf(secret: unknown): string | null {
  if (typeof secret !== "string") return null;
  const match = SECRET_PATTERN.exec(secret);
  if (!match) return null;
  const hex = match[1]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Compares two lower-case hex SHA-256 digests in constant time. */
export function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
}

/** A digest no secret hashes to, compared against when no record exists so a miss costs the same as a mismatch. */
const NO_RECORD_DIGEST = hashCredentialSecret("corvis_sa_no_such_credential");

/** The identity a valid credential stands for. The caller must still resolve it through the normal authorization path. */
export type VerifiedServiceAccountCredential = {
  tenantId: string;
  serviceAccountId: string;
  credentialId: string;
  /** The `identity_subject.subject` (auth_method `service_account`) that membership, entitlements and data rights resolve. */
  subject: string;
  workspaceId: string;
  roleName: string;
};

/** A use more recent than this is not recorded again, so a busy caller is not a write per request. */
const LAST_USED_GRANULARITY = "1 minute";

/**
 * Checks a presented secret against the stored record: the record exists, the digests match (constant time), the
 * credential is in use (active, not expired, not ended by a rotation or a revocation) and its account is active and
 * unexpired. Every refusal is the same `null`, so a caller cannot tell an unknown credential from a wrong secret from
 * a revoked one. A match records the use.
 *
 * Nothing in the request path calls this yet: how a presented credential reaches the API (an exchange for a signed
 * identity assertion, or an IdP client-credentials token) is a pending decision (docs/SERVICE_ACCOUNTS.md). This is
 * the record-side half of either choice, so its semantics (immediate revocation, rotation overlap, expiry) are fixed
 * and tested now. A successful result is an authenticated subject only: roles, entitlements and data rights are still
 * re-resolved from Postgres by the authorization path, which also enforces the lifecycle grant and session revocation.
 */
export async function verifyServiceAccountCredential(secret: unknown, db: PostgresSqlApi): Promise<VerifiedServiceAccountCredential | null> {
  const credentialId = credentialIdOf(secret);
  if (credentialId === null) return null;
  const rows = await db.query(`select c.tenant_id::text as tenant_id, c.credential_id::text as credential_id, c.service_account_id::text as service_account_id,
      c.secret_sha256, a.subject, a.workspace_id::text as workspace_id, a.role_name,
      (c.status = 'active' and c.expires_at > now() and (c.ends_at is null or c.ends_at > now())
        and a.status = 'active' and a.expires_at > now()) as usable
    from corvis_control.service_account_credential c
    join corvis_control.service_account a on a.tenant_id = c.tenant_id and a.service_account_id = c.service_account_id
    where c.credential_id = $1::uuid`, [credentialId]);
  const row = rows[0];
  const matches = sameDigest(hashCredentialSecret(secret as string), row ? String(row.secret_sha256) : NO_RECORD_DIGEST);
  if (!row || !matches || row.usable !== true) return null;
  await db.execute(`update corvis_control.service_account_credential set last_used_at = now()
    where tenant_id = $1::uuid and credential_id = $2::uuid and (last_used_at is null or last_used_at < now() - interval '${LAST_USED_GRANULARITY}')`,
  [String(row.tenant_id), credentialId]);
  return {
    tenantId: String(row.tenant_id),
    serviceAccountId: String(row.service_account_id),
    credentialId,
    subject: String(row.subject),
    workspaceId: String(row.workspace_id),
    roleName: String(row.role_name),
  };
}
