# Runtime surface isolation

Corvis deploys the same reviewed application image into multiple runtime roles, but a shared image must not imply a shared exposed route surface.

## Surface derivation

In Cloud Run, the application derives its runtime surface from the provider-supplied `K_SERVICE` name:

- `corvis-api-${environment}` -> `api`
- `corvis-worker-${environment}` -> `worker`
- `corvis-admin-${environment}` -> `admin`
- `corvis-customer-${environment}` -> `customer`

`CORVIS_RUNTIME_SURFACE` may explicitly override the derived value for controlled non-standard deployments. Unknown production service identities fail closed to `disabled`; local development and explicit demo mode retain the combined surface.

No GitHub variable is required for this contract.

## Exposure matrix

| Surface | Allowed application routes | Explicitly excluded |
| --- | --- | --- |
| `api` | `/api/v1` and `/api/v1/**` | browser pages and `/api/internal/**` |
| `worker` | `/api/internal/**` plus `/api/v1/health` | public/customer/admin API and browser pages |
| `admin` | `/admin/**`, `/api/v1/admin/**`, static Next assets and health | customer pages, customer API, internal worker routes |
| `customer` | customer browser pages/static assets and health | all `/api/**` and `/admin/**` |
| `combined` | all routes | local/demo compatibility only |
| `disabled` | health only | everything else |

The existing browser/API request-security checks remain active after the surface gate for allowed `/api/**` requests.

## Deployment sequencing

The current `api` and `worker` Cloud Run names automatically activate `api` and `worker` isolation as soon as this code is deployed. This does not yet create customer/admin Cloud Run services.

Future `corvis-admin-*` and `corvis-customer-*` services must use these application-level contracts before they are published. The admin service must not expose customer routes, the customer service must not expose privileged admin/API routes, and neither service should depend on obscurity or hostname routing as its authorization boundary.

This is a prerequisite for the separate customer/admin runtime work tracked by #13 and #10; it intentionally avoids cosmetic duplicate services that still expose the combined Next.js application.
