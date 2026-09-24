# Infrastructure and deployment architecture

This file is the technical source of truth for Corvis infrastructure implementation. Confluence owns business-level technology decisions and readiness requirements.

## Production topology

```text
Internet
  ↓
Cloudflare — authoritative DNS / TLS / DDoS / WAF / rate controls
  ↓ Worker overwrites x-api-key with Terraform-managed edge key
Google API Gateway
  ↓ dedicated gateway service account
Cloud Run API — IAM-private, scale-to-zero
  ├─ Supabase Postgres — authoritative structured state
  ├─ GCS + KMS — source/replay evidence
  └─ durable processing outbox
          ↓
      Pub/Sub / Cloud Tasks / Cloud Scheduler
          ↓ Google OIDC, dedicated custom audience
      Cloud Run worker — IAM-private, scale-to-zero
          ├─ bounded stage execution / retry / recovery
          ├─ GCS evidence reads
          └─ Postgres stage/effect state

Optional downstream only after approval:
Postgres/GCS -> Snowflake analytics / secure sharing
```

Large source documents do not traverse the Cloudflare Worker or API Gateway. The API authorizes/initiates upload and the client writes source bytes directly to GCS using the resumable-upload contract.

## Principles

1. **Git is implementation authority.** Terraform, SQL migrations and workflows are reviewed/versioned here.
2. **GitHub Actions is the post-bootstrap deployment control plane.** Routine provider changes should not require local consoles/CLI.
3. **GitHub is not the runtime secret store.** Runtime secrets live in GCP Secret Manager; provider deployment tokens remain CI-only.
4. **Federation before long-lived credentials.** GCP deployment uses GitHub OIDC -> WIF. Runtime-to-runtime calls use workload identity/OIDC.
5. **IAM is the Cloud Run origin boundary.** API Gateway is the only normal API invoker; the dedicated worker identity is the only normal worker invoker. No `allUsers` grant is baseline.
6. **Postgres is the sole structured write authority.** Snowflake is optional downstream only.
7. **GCS is retained source/replay evidence.** Database rows keep governed references/hashes rather than large source BLOBs.
8. **Scale to zero by default.** API and worker min instances are zero unless measured SLO evidence justifies a floor.
9. **One fact, one owner.** Derived IDs/URLs/names flow from Terraform/provider outputs instead of duplicated GitHub variables.
10. **No Corvis-managed AWS baseline.** A vendor being hosted on AWS does not require Corvis AWS infrastructure.
11. **One Cloudflare root zone, one zone-policy owner.** UAT and prod share one configurable root domain but never independently own the same zone-level Terraform resources.

## Environment model

Canonical environments are `dev`, `uat`, `prod` with separate Terraform roots and isolated GCP/Postgres state. Prefer separate GCP projects and require separate Supabase/Postgres projects. `uat` uses synthetic or explicitly sanitized data; production customer data never belongs in `dev` or UAT.

Cloudflare is the deliberate exception to provider-zone isolation: UAT and production share one root domain/zone because the public names are first-level subdomains of the same company domain. The environments still have independent hostname resources and runtime state.

```text
infra/terraform/environments/
  dev/
  uat/
  prod/

infra/terraform/shared/
  cloudflare/     # independent state and lifecycle for zone-wide policy
```

Production hostnames are `api.${zone}`, `app.${zone}`, `admin.${zone}`. UAT uses `api-uat.${zone}`, `app-uat.${zone}`, `admin-uat.${zone}`. Do not introduce nested `*.uat.${zone}` hostnames into the baseline because normal full-zone Universal SSL covers the apex and first-level subdomains, not deeper names.

## Terraform ownership

```text
infra/terraform/
  modules/
    gcp-foundation/            # services, identities, GCS/KMS, registry,
                               # Pub/Sub, Cloud Tasks and transport IAM
    cloud-run-runtime/         # API + private worker, Postgres Secret Manager binding,
                               # Pub/Sub push, Scheduler and runtime configuration
    gcp-api-gateway/           # API Gateway, restricted edge key, gateway identity
    cloudflare-edge/           # environment API Worker + DNS + route only
    cloudflare-customer-edge/  # environment customer Worker + DNS + route only
    cloudflare-admin-edge/     # environment admin Worker + DNS + route only
    cloudflare-zone-policy/    # single owner of zone TLS/WAF/rate/cache policy
    gcp-observability/         # API/queue/DLQ alerts, dashboard, optional budget
  environments/
    dev/
    uat/
    prod/
  shared/
    cloudflare/                # dedicated root/state for shared zone policy

db/postgres/migrations/       # authoritative schemas/RLS/roles/functions/data contract
```

A Cloudflare phase has at most one zone entry-point ruleset. Therefore no UAT/prod environment module may own `cloudflare_ruleset` or `cloudflare_zone_setting`; those resources belong only to `infra/terraform/shared/cloudflare`. Regression tests enforce this boundary.

The prior external load-balancer/Cloud Armor/mTLS bridge is intentionally removed from the baseline. Reintroduce an always-on LB only for a documented requirement the identity-based gateway cannot satisfy.

## GCP foundation

The baseline enables the APIs needed for API Gateway/API Keys, Cloud Run, Cloud Scheduler, Cloud Tasks, Pub/Sub, Secret Manager, KMS, Artifact Registry, Storage, Logging/Monitoring and IAM/WIF.

### Runtime identities

- `corvis-api-${environment}` — API application identity.
- `corvis-worker-${environment}` — background-processing identity.
- `corvis-gateway-${environment}` — API Gateway backend identity.
- `corvis-deploy` — deployment identity used only from GitHub WIF.

Production applies organization policy that disables user-managed service-account key creation/upload. Runtime identities are keyless.

### API origin

API Gateway is network-reachable and invokes `corvis-api-${environment}` using the dedicated gateway service account. Cloud Run therefore uses `INGRESS_TRAFFIC_ALL`, but IAM—not network location—is the authorization boundary. The API service grants `roles/run.invoker` only to the gateway identity.

The Cloudflare Worker injects a Terraform-generated Google API key restricted to the generated managed API. The edge key proves approved edge traversal only; it is never customer authentication.

### Private worker and asynchronous transport

`cloud-run-runtime` creates a separate `corvis-worker-${environment}` service using the same immutable image but a separate service account and invocation policy.

The worker has an explicit custom OIDC audience:

`https://corvis-worker-${environment}.internal`

Only the worker service account receives `roles/run.invoker` on the worker service. Managed transports use that identity/audience:

- Pub/Sub push subscription -> `/api/internal/processing-stage` for immediate stage deliveries;
- Cloud Tasks -> `/api/internal/processing-stage` for persisted scheduled retries;
- Cloud Scheduler -> `/api/internal/delivery` to drain durable processing/export/webhook outboxes.

Pub/Sub/Cloud Tasks/Cloud Scheduler service agents may mint short-lived tokens for the worker identity. The API may enqueue Cloud Tasks and publish processing events and has only the `actAs` permission needed for OIDC task creation. Because the scheduled `/api/internal/delivery` drain runs on the worker, the worker identity holds the same resource-scoped grants: `roles/pubsub.publisher` on the processing topic, `roles/cloudtasks.enqueuer` on the processing queue and `roles/iam.serviceAccountUser` on itself. No production shared worker secret is required.

Messages that exhaust push delivery are dead-lettered to `processing-dead-letter-${environment}` and retained for 7 days on the non-expiring pull subscription of the same name for inspection/replay; the dead-letter alert watches that subscription's undelivered-message count.

### GCS and KMS

The source bucket is regional, private, versioned, CMEK-encrypted, uniform-access and public-access-prevention protected. The project's Cloud Storage service agent is granted `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the source key only.

The API's actual upload/quarantine adapter performs object create/read/list/delete operations, so it receives object-level `roles/storage.objectUser`, not bucket administration. Worker access is read-only unless a later bounded stage explicitly requires more.

Transient/quarantine/export/intermediate data has lifecycle cleanup (noncurrent versions under those prefixes are deleted 7 days after becoming noncurrent); retained source evidence follows governance/legal retention rather than a cost-only timer.

### Secret Manager

The baseline runtime secret container is:

`corvis-postgres-dsn-${environment}`

Terraform owns the container/IAM, not the secret value. The external Supabase/Postgres activation path writes an enabled DSN version without putting plaintext into Terraform state or GitHub variables. API, worker, migration and Security-acceptance workflows consume the same value through IAM.

## Authentication and authorization

The default production identity path is standards-based OIDC:

1. client obtains a token from the approved environment IdP;
2. Corvis verifies issuer/audience/signature/timestamps from OIDC discovery/JWKS;
3. requested tenant/workspace context remains untrusted input;
4. Postgres re-resolves active membership, roles, resource/data-right entitlements and session state before authorization.

The signed Corvis assertion contract remains available for a reviewed SAML/identity broker. It is not required for the default OIDC path.

Browser/customer/admin SSO integration remains provider-specific and should be implemented only after the approved IdP/browser session contract is chosen; do not encode a speculative Firebase/Auth0/etc. dependency into baseline infrastructure.

Browser trust is always exact-origin. UAT API CORS/upload origins are only the UAT `app-uat`/`admin-uat` hostnames; production uses only `app`/`admin`. Wildcard root-domain CORS is prohibited. If browser sessions later use cookies, host-only cookies are the baseline: omit a parent `Domain=.${zone}` attribute unless an explicit reviewed requirement needs cross-subdomain cookies.

## Cloudflare

Cloudflare owns authoritative public DNS/TLS/DDoS/WAF/rate/cache controls through two deliberately different lifecycles.

### Shared zone policy

`infra/terraform/shared/cloudflare` is applied through `.github/workflows/cloudflare-zone-policy.yml`. It owns:

- strict origin TLS, TLS 1.3, Always Use HTTPS and automatic HTTPS rewrites;
- three custom WAF rules scoped to the six Corvis application hostnames;
- optional Cloudflare/OWASP managed rules scoped to those same hostnames;
- the single zone rate-limit entry ruleset;
- authenticated-surface shared-cache bypass scoped to the six Corvis hostnames.

The shared state is held in `${UAT_GCP_PROJECT_ID}-corvis-shared-tf-state` under `corvis/cloudflare-zone-policy`, not the ordinary UAT environment state bucket. This keeps zone policy alive if UAT runtime/state is idled or fully decommissioned.

Shared zone mutation uses the dedicated `CLOUDFLARE_ZONE_POLICY_TOKEN`; environment edge tokens do not need zone-policy authority.

On Cloudflare Free, the one available rate-limit rule is path/IP based because Host is not an available Free match field. Corvis's Postgres-backed per-identity limit remains authoritative and environment-specific. On Pro mode (`CLOUDFLARE_MANAGED_WAF_ENABLED=true`), the shared ruleset uses two independent hostname-scoped rules—one prod, one UAT—within Pro's two-rule entitlement.

### Environment edge

Each environment owns only its deterministic host resources: API/customer/admin Worker, deployment, route and proxied DNS record. `workers.dev` and previews remain disabled. UAT cannot destroy production zone policy and prod cannot take ownership of UAT host resources through Terraform composition.

Cloudflare DNS API permission is zone-scoped rather than record-name-scoped, so token scope alone cannot provide perfect record-level separation inside one zone. Corvis compensates with separate states, deterministic hostname derivation, main-only reviewed applies, non-bypassable CI and tests that prohibit zone resources in environment modules.

See [`CLOUDFLARE_SHARED_ZONE.md`](CLOUDFLARE_SHARED_ZONE.md) for the full operating and token-permission contract.

## Supabase/Postgres

Supabase Postgres Singapore is the authoritative structured application/control/canonical platform. Use separate environment projects. SQL migrations own schemas, indexes, constraints, RLS, roles/grants/functions and replication definitions.

`terraform-deploy.yml` creates the Terraform plan first, then for a promoted runtime reads the DSN from Secret Manager, applies only pending checksum-verified migrations and uploads migration evidence before applying the exact Terraform plan. That keeps database and runtime promotion in one auditable GitHub path.

Backups/restore/PITR are provider operating capabilities and must be exercised in live UAT; their existence cannot be proven from Terraform alone.

## Snowflake

Snowflake starts absent. Activate it only for an approved customer sharing/analytics/concurrency trigger. Postgres remains authoritative; no application dual writes. Snowflake failure cannot block core application writes.

## Observability and cost

Baseline Terraform provides API error, queue-depth and DLQ alerts plus a summary dashboard and optional budget. Notification channels and billing-account budget ownership are genuine environment inputs and remain inactive until configured.

Cost guardrails:

- API/worker min instances = zero;
- usage-priced API Gateway + Cloudflare Worker instead of fixed LB/Armor baseline;
- bounded Artifact Registry retention;
- lifecycle cleanup for transient GCS data;
- Snowflake cost = zero until activation;
- idle UAT removes runtime/public edge while retaining durable foundation/data/state;
- one Cloudflare root zone avoids a second domain/zone solely for UAT.

Supabase is outside GCP teardown; an idle paid UAT Postgres project must be deliberately paused/down-sized/decommissioned according to provider capabilities and data-retention policy rather than assumed to disappear with Terraform.

## Terraform remote state and lifecycle

Environment state is held in a private versioned GCS bucket created by the bootstrap workflow. Noncurrent versions are bounded by lifecycle policy.

The shared Cloudflare policy has a separate private/versioned state bucket, `${UAT_GCP_PROJECT_ID}-corvis-shared-tf-state`, created/hardened by the shared-zone workflow. It is intentionally outside `gcp-decommission.yml`'s environment bucket deletion path. Moving that state to another project later is a reviewed state-migration operation, not an ordinary UAT lifecycle action.

`gcp-decommission.yml` owns environment lifecycle transitions:

- `idle` — remove that environment's API/worker/public DNS/Workers while preserving durable GCP foundation/data/state and the independent shared Cloudflare zone policy;
- `full` — explicitly prepare protected environment resources for deletion, detach the retained KMS bootstrap anchor, destroy remaining environment-managed resources, verify empty environment state, hibernate KMS and delete the environment remote state bucket last.

The external project/WIF/deploy trust anchor remains so the environment can be rebuilt without introducing static credentials. Shared Cloudflare state/policy remains independent unless its own reviewed workflow explicitly changes it.

## One-time bootstrap exceptions

These cannot safely self-create before GitHub is trusted:

- GCP project/billing ownership;
- initial `corvis-deploy` service account and repository/environment-restricted WIF pool/provider/impersonation;
- Cloudflare account/zone ownership and scoped provider tokens once a domain is selected;
- Supabase organization/project/billing ownership and provider-derived DSN activation;
- approved IdP tenant/client ownership;
- third-party account/contract setup for any enabled external provider.

A Cloudflare domain is **not** required for the GCP foundation bootstrap. After the GCP trust root exists, bootstrap may proceed with Cloudflare disabled. When a domain is later selected, apply shared Cloudflare zone policy before activating environment public-edge resources.

After provider trust roots exist, routine resource/configuration changes should flow from reviewed GitHub workflows where the provider supports it.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md), [`CLOUDFLARE_SHARED_ZONE.md`](CLOUDFLARE_SHARED_ZONE.md), [`DEPLOYMENT.md`](DEPLOYMENT.md), [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md), and [`DATA_PLATFORM.md`](DATA_PLATFORM.md).
