# API compatibility and deprecation policy

Corvis treats `/api/v1` as a published customer contract. Additive changes may land in v1 when they preserve existing request/response meaning and authorization. Breaking changes require a new versioned contract rather than silently changing v1.

## Compatibility gate

`openapi/v1-compatibility-baseline.json` records the path/method surface already published in `openapi/corvis-v1.yaml`. CI fails if a baseline operation disappears from the v1 OpenAPI document or if the stable correlation/error/security conventions disappear. Adding a new operation is allowed; removing or renaming an existing operation requires a new API version and migration plan.

The baseline is intentionally append-only for `/api/v1`. Do not edit it to make a breaking change pass. If an operation must eventually retire, keep v1 behavior available during its supported window and introduce the replacement under a new version when the change is breaking.

## What counts as breaking

Examples include removing/renaming a path or method, making an optional request field required, narrowing an accepted enum, removing a response field customers may rely on, changing identifier meaning, changing tenant/entitlement semantics, changing idempotency behavior incompatibly, or replacing a stable error code with a different meaning.

Security tightening that corrects unauthorized access is not held back for compatibility. Such a change must still be documented and communicated because clients relying on access they were never entitled to may observe different results.

## Deprecation lifecycle

Before intentionally retiring a supported external capability:

1. document the replacement and migration instructions;
2. identify affected customer integrations from available delivery/API telemetry without logging confidential payloads;
3. publish a deprecation notice through the governed customer-communication channel;
4. where the HTTP contract is being retired, return standards-compatible `Deprecation` and `Sunset` response headers during the announced window when technically applicable;
5. keep security fixes, tenant isolation and data-right enforcement authoritative throughout the window;
6. do not remove the v1 operation until the supported window has ended and the replacement contract is available;
7. retain the decision, approval, customer communication and migration evidence.

No deprecation window may be used to preserve a known authorization, privacy or tenant-isolation vulnerability.

## Versioning rule

A breaking resource redesign uses a new prefix such as `/api/v2`; v1 remains stable for its supported period. Internal database tables, extraction-provider payloads and worker-only routes are not external contracts and do not acquire customer compatibility guarantees merely because they exist in the repository.

## Webhooks and exports

Webhook event payloads and export schemas are external contracts too. A breaking webhook event/schema change requires a versioned event contract or an equivalent explicit migration mechanism. Export manifest/schema/taxonomy versions must remain attributable so a consumer can determine which contract produced an artifact.
