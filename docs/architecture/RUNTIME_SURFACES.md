# Runtime surface isolation

Corvis deploys the same reviewed application image into multiple runtime roles, but a shared image must not imply a shared exposed route surface.

## Surface derivation

In Cloud Run, the application derives its runtime surface from the provider-supplied `K_SERVICE` name:

- `corvis-api-${environment}` -> `api`
- `corvis-worker-${environment}` -> `worker`
- `corvis-cost-guard-${environment}` -> `cost_guard`
- `corvis-admin-${environment}` -> `admin`
- `corvis-customer-${environment}` -> `customer`

`CORVIS_RUNTIME_SURFACE` may explicitly override the derived value for controlled non-standard deployments. Unknown production service identities fail closed to `disabled`; local development and explicit demo mode retain the combined surface.

No GitHub variable is required for this contract.

## Exposure matrix

| Surface | Allowed application routes | Explicitly excluded |
| --- | --- | --- |
| `api` | `/api/v1` and `/api/v1/**` | browser pages and `/api/internal/**` |
| `worker` | `/api/internal/**` plus `/api/v1/health` | public/customer/admin API and browser pages |
| `admin` | `/admin`, `/admin/**`, static Next assets and health probes | all other API routes, customer pages and worker routes |
| `customer` | customer browser pages/static assets and health | all `/api/**` and `/admin/**` |
| `combined` | all routes | local/demo compatibility only |
| `cost_guard` | `/api/internal/budget-guard` and health probes | all other application routes |
| `disabled` | health probes only | everything else |

The existing browser/API request-security checks remain active after the surface gate for allowed `/api/**` requests.

## Deployment wiring

UAT/prod Terraform provisions separate API, worker, customer and admin services. Customer/admin presentation runtimes use `cloud-run-customer` with distinct `surface` values, identities and gateway/edge paths; neither receives database credentials. The API origin remains authoritative for customer and admin data requests. The admin edge forwards only allowlisted privileged API route families; those routes are not executed in the admin presentation service.

Every surface permits both `/api/v1/health` and `/api/v1/health/ready`; these probes do not grant access to application data. The UAT cost-guard service has its own restricted surface and identity. Unknown production identities fail closed.

These are implemented repository boundaries, not proof of deployed isolation. Provider-backed UAT must still exercise direct-origin denial, route separation, tenant/admin authorization and the configured edge paths under #8, #10 and #13.
