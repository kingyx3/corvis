import { apiError, json } from "../../../../platform/http/api/http.ts";
import { getServerConfig, type ServerConfig } from "../../../../platform/config/config.ts";
import { normalizeOidcIssuer, OidcVerifier, unverifiedLogoutTokenIssuer, type OidcLogoutToken } from "./oidc.ts";
import { postgres, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { RateLimiter, RATE_LIMIT_WINDOW_MS } from "../../../../platform/http/limits/rate-limit.ts";
import { classifyOidcFailure } from "../../../../platform/http/identity/request-context.ts";
import { countMetric, logEvent } from "../../../../platform/observability/telemetry.ts";

/**
 * OpenID Connect Back-Channel Logout 1.0 receiver (F7c, #336), behind `POST /api/v1/auth/oidc/backchannel-logout`.
 *
 * The identity provider calls this endpoint when it ends a person's session. The request carries no Corvis credential: it is
 * authenticated ONLY by the signed `logout_token`, which is verified against the keys of an issuer Corvis already trusts
 * (the deployment's shared provider, or a tenant's active recorded OpenID Connect provider) and an audience recorded for it
 * (`OidcVerifier.verifyLogoutToken`: signature, issuer, audience, fresh `iat`, `exp`, the back-channel-logout event, no
 * `nonce`). An issuer Corvis does not know is refused before any network call, so the endpoint cannot be made to fetch keys
 * from an arbitrary host. The single-use `jti` ledger, the revocations (the existing `session_revocation`,
 * which every authoritative request consults, so the effect is immediate) and the audit events are written atomically by
 * `corvis_control.apply_backchannel_logout`, bounded to the tenants that issuer and audience belong to.
 *
 * Responses follow the specification and reveal nothing: `200` with an empty body once a valid token was applied (whether or not
 * it matched anyone Corvis knows), `400 invalid_request` for anything else (malformed, forged, expired, replayed, unknown
 * issuer, wrong audience: one answer), `429` when rate limited and `503` when keys or the database could not be reached,
 * so the identity provider may retry. The token, the subject and the session id are never logged.
 */

/** Largest request body read: a logout token is a few hundred bytes; the verifier refuses more than 8 KiB anyway. */
const MAX_BODY_BYTES = 16 * 1024;
/** A process-wide ceiling on requests from anyone, before any key fetch or signature check; the SQL function also bounds each issuer. */
export const BACKCHANNEL_LOGOUT_REQUESTS_PER_MINUTE = 300;
const limiter = new RateLimiter(BACKCHANNEL_LOGOUT_REQUESTS_PER_MINUTE, RATE_LIMIT_WINDOW_MS);

export type BackchannelLogoutDeps = {
  verifier?: Pick<OidcVerifier, "verifyLogoutToken">;
  db?: PostgresSqlApi;
  config?: ServerConfig;
  limiter?: RateLimiter;
  now?: Date;
  correlationId?: string;
};

let defaultVerifier: OidcVerifier | undefined;
function productionVerifier(): OidcVerifier {
  if (!defaultVerifier) defaultVerifier = new OidcVerifier();
  return defaultVerifier;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function rejected(id: string): Response {
  return json({ error: "invalid_request", correlationId: id }, { status: 400, headers: NO_STORE });
}

async function readLogoutToken(request: Request): Promise<string | undefined> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return undefined;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return undefined;
  const values = new URLSearchParams(body).getAll("logout_token");
  return values.length === 1 && values[0] ? values[0] : undefined;
}

/** The deployment's shared provider as the verifier normalises it, or undefined when none is configured or it is unusable. */
function sharedProvider(config: ServerConfig): { issuer: string; audience: string } | undefined {
  if (!config.authIssuer || !config.authAudience) return undefined;
  try { return { issuer: normalizeOidcIssuer(config.authIssuer), audience: config.authAudience }; } catch { return undefined; }
}

export async function handleBackchannelLogout(request: Request, deps: BackchannelLogoutDeps = {}): Promise<Response> {
  const id = deps.correlationId ?? crypto.randomUUID();
  const context = { correlationId: id };
  try {
    const config = deps.config ?? getServerConfig();
    const decision = (deps.limiter ?? limiter).consume("backchannel-logout", deps.now?.getTime());
    if (!decision.allowed) {
      logEvent("warn", "auth.backchannel_logout_rate_limited", context);
      return json({ error: "rate_limited", correlationId: id }, { status: 429, headers: { ...NO_STORE, "retry-after": String(decision.retryAfterSeconds) } });
    }
    // Demo mode has no identity provider: there is nothing a logout could end.
    if (config.demoMode) return rejected(id);

    const token = await readLogoutToken(request);
    if (token === undefined) return rejected(id);
    let issuer: string;
    try { issuer = unverifiedLogoutTokenIssuer(token); } catch { return rejected(id); }

    const db = deps.db ?? postgres(config.databaseDsn);
    const sharedCandidate = sharedProvider(config);
    const shared = sharedCandidate?.issuer === issuer ? sharedCandidate : undefined;
    const recorded = await db.query(`select distinct audience from corvis_control.tenant_identity_provider
      where protocol = 'oidc' and status = 'active' and issuer = $1 order by audience limit 20`, [issuer]);
    const audiences = [...new Set([...(shared ? [shared.audience] : []), ...recorded.map((row) => String(row.audience))])];
    if (audiences.length === 0) {
      logEvent("warn", "auth.backchannel_logout_rejected", context, { reason: "unknown_issuer" });
      return rejected(id);
    }

    let verified: OidcLogoutToken;
    try {
      verified = await (deps.verifier ?? productionVerifier()).verifyLogoutToken({
        token, issuer, audiences, jwksUrl: shared ? config.authJwksUrl : undefined, now: deps.now,
      });
    } catch (error) {
      const reason = classifyOidcFailure(error);
      // Only our own verifier text is logged, never the token.
      logEvent(reason === "idp_unavailable" ? "error" : "warn", "auth.backchannel_logout_rejected", context, { reason, message: error instanceof Error ? error.message : "unknown" });
      // The identity provider may retry when its keys could not be fetched; everything else is a plain refusal.
      return reason === "idp_unavailable" ? json({ error: "temporarily_unavailable", correlationId: id }, { status: 503, headers: { ...NO_STORE, "retry-after": "30" } }) : rejected(id);
    }

    const applied = await db.query(`select r->>'status' as status, (r->>'revokedSessions')::integer as revoked_sessions, (r->>'tenants')::integer as tenants
      from (select corvis_control.apply_backchannel_logout($1,$2,$3,$4,$5,$6::boolean,$7) as r) x`, [
      verified.issuer, verified.audience, verified.jti, verified.subject ?? null, verified.sessionId ?? null,
      shared?.audience === verified.audience, id,
    ]);
    const status = String(applied[0]?.status);
    if (status === "ok") {
      // Counts only: who was signed out is in the tenant's audit trail, never in the logs.
      logEvent("info", "auth.backchannel_logout_applied", context, { revokedSessions: Number(applied[0]?.revoked_sessions), tenants: Number(applied[0]?.tenants), scope: verified.sessionId ? "session" : "subject" });
      countMetric("auth.backchannel_logout_applied", 1, context);
      return new Response(null, { status: 200, headers: { ...NO_STORE, "x-content-type-options": "nosniff" } });
    }
    if (status === "replay") {
      logEvent("warn", "auth.backchannel_logout_rejected", context, { reason: "replay" });
      return rejected(id);
    }
    if (status === "rate_limited") {
      logEvent("warn", "auth.backchannel_logout_rate_limited", context, { scope: "issuer" });
      return json({ error: "rate_limited", correlationId: id }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });
    }
    // Anything else is not an answer this code knows: neither success nor refusal can be claimed.
    throw new Error("unexpected back-channel logout result");
  } catch (error) {
    return apiError(error, id);
  }
}
