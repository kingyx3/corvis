# Economic entity identity and lifecycle

This document defines the repository implementation contract for durable fund/company identity when names, ownership, legal structure or corporate structure change.

Confluence remains authoritative for business semantics. The primary references are:

- Canonical Data Model, Taxonomy & Lineage
- Reference — Alias & Mapping Registry
- Reference — Controlled Taxonomies & Enums
- AI Extraction Skill — Quarterly Fund Reports
- Reference — AI Agent Execution Contract & Structured Output Schema

The Postgres implementation is in `db/postgres/migrations/032_economic_entity_identity_lifecycle.sql` and the reviewed-candidate materialization path is extended by migrations `036`–`038`.

## Core rule

**Names are attributes of an identity, not the identity itself.**

`global_fund_id` and `global_company_id` are immutable internal economic IDs. They are never replaced merely because an entity changes its legal name, trading name, marketed name, program code, ticker, domicile, manager or branding.

Conversely, two records must not be merged merely because their names normalize to the same string. Name similarity is evidence for resolution, not an identity key.

## Reviewed extraction materialization

Reviewed extraction enters canonicalization through a layered transactional chain:

```text
reviewed candidate set
        |
        v
v1 canonical ledger + source references + observations
        |
        v
v4 reviewed fund/company identity materialization
        |
        v
v3 lifecycle events -> v2 holdings/instruments -> replay-safe v1
```

The v4 identity step only accepts a fund/company candidate that already carries an explicit durable `global_fund_id` or `global_company_id`. It never manufactures an identity from a name, normalized-name match or model guess. A missing durable identity remains a governed resolution problem rather than becoming a new global entity accidentally.

When an explicit reviewed ID does not yet exist, v4 may create the new global identity using the reviewed canonical/source name. When the ID already exists, tenant evidence does **not** overwrite its current global canonical name. The source label is instead retained in `tenant_entity_name` as approved tenant-scoped evidence, with source-reference lineage and a revision record. This allows historical/former/private labels to coexist without leaking them into the global directory.

The entire v4 -> v3 -> v2 -> v1 call is one Postgres statement. A downstream holding, instrument, lifecycle or observation failure rolls back any new identity created by the same canonicalization attempt.

## Data structures

| Structure | Purpose |
| --- | --- |
| `corvis_identity.fund` / `company` | Durable global economic identity and current display/canonical name. |
| `corvis_identity.entity_name` | Global non-confidential current and historical names/aliases. |
| `corvis_identity.tenant_entity_name` | Tenant-private source labels, codenames and aliases protected by RLS. |
| `corvis_identity.tenant_entity_revision` | Tenant-scoped immutable reviewed fund/company materialization lineage. |
| `corvis_identity.entity_external_identifier` | LEI, CIK, registry IDs, tickers, security/vendor/GP-admin identifiers with history. |
| `corvis_identity.entity_lifecycle_event` | What happened and when. |
| `corvis_identity.entity_lifecycle_participant` | Which durable identities participated and in what role. |
| `corvis_identity.tenant_lifecycle_revision` | Tenant-scoped reviewed lifecycle-event materialization lineage. |
| `corvis_identity.entity_relationship` | Traversable current/historical relationships between identities. |
| `corvis_serving.entity_directory` | Global directory read model with current and former names plus external identifiers. |
| `corvis_serving.entity_relationships` | Relationship graph read model. |

Global identity tables contain only non-client-confidential identity metadata. Source-derived private aliases remain tenant scoped.

## Scenario matrix

| Scenario | Identity treatment | Required history / relationship |
| --- | --- | --- |
| Legal rename or rebrand | Keep the same global ID. | Close the prior current name in name history; add the new current canonical/legal/trading name. Record `rename` lifecycle event when economically meaningful/evidenced. |
| Spelling/capitalization correction | Keep the same global ID. | Preserve prior recorded label when it was genuinely observed; mark correction context rather than inventing a corporate event. |
| Multiple simultaneous legal/trading/marketed names | Keep one global ID when they refer to the same economic entity. | Store multiple name rows with `name_kind`; do not force a single alias string. |
| Fund marketed name or GP program-code change | Keep the same fund ID if the underlying vehicle/economic identity is unchanged. | Preserve old program/marketed names. |
| Manager change for the same fund | Keep the same fund ID unless evidence shows the vehicle itself changed. | Record `manager_change`; manager name is not an identity key. |
| Feeder and master funds | Always distinct fund IDs. | Represent feeder→master through the holding graph; never as aliases. |
| Acquisition where target remains a legal/economic entity | Keep acquirer and target as separate IDs. | `acquisition` event plus `acquired_by`/parent-subsidiary relationship with validity dates. |
| Acquisition where target is absorbed into surviving acquirer | Keep both historical IDs; the target ID is never recycled or rewritten into the acquirer. | Mark target participation as non-continuing; link target to surviving entity with lifecycle event / historical relationship. |
| Merger where one existing company survives | Keep the survivor's ID and the other constituent's historical ID. | `merger`; constituent/surviving roles; historical `merged_into`/successor relationship. |
| Merger creating a new company | Create a new ID for the new economic/legal entity. Preserve every predecessor ID. | Many predecessor participants → one successor/resulting entity. |
| Split/demerger into multiple companies | Preserve original ID for its historical entity; create IDs for distinct resulting entities. | One source/predecessor → multiple resulting/successor participants. |
| Spin-off | Parent and spun-off company are separate IDs. | `spin_off`; parent/child or `spun_off_from` relationship with effective date. |
| Carve-out | Use a new ID only when a distinct economic/legal entity is evidenced. | `carve_out`; source/resulting participants. Do not invent a company merely because a business line is mentioned. |
| Partial divestiture | Do not collapse either entity. | `partial_divestiture`; buyer/seller/transferred-entity roles and ownership before/after where known. |
| Reorganization / legal-form conversion / domicile change | Usually keep the same ID when continuity is clear. | Record event and name/identifier changes. If a new legal/economic entity is actually created, create a successor ID instead. |
| Fund restructure / continuation transaction | Preserve each legally/economically distinct vehicle as its own ID. | `fund_restructure` plus predecessor/successor/related-vehicle relationships; transfer of assets does not make two funds aliases. |
| IPO/listing, delisting or take-private | Normally keep the same company ID. | Record listing-state lifecycle event; ticker/security identifiers may begin/end independently. |
| Dissolution or liquidation | Keep the historical ID permanently. | `dissolution`/`liquidation`; current relationships become historical as appropriate. Never delete/recycle identity. |
| Same name used by unrelated entities | Separate IDs. | External identifiers, manager/context, jurisdiction and source evidence disambiguate; normalized name is not unique. |
| Persistent masked `Project X` codename | Do not deanonymize externally. | Tenant-private alias/code-name history; global alias only when rights/governance allow and identity is actually disclosed. |
| Tenant-specific internal codename | Never promote automatically to the global directory. | Store in `tenant_entity_name` under RLS with evidence/confidence/review status. |
| External identifier changes | Keep identity if economic continuity is established. | Close prior identifier validity and add the new identifier. |

## Rename versus successor decision

Use a **rename on one ID** when the same economic/legal entity continues and only its name/branding/administrative attributes change.

Use a **new successor ID** when evidence indicates a newly constituted economic/legal entity, a many-to-one merger into a new entity, a one-to-many split/demerger, or another event where continuity cannot be represented honestly as one enduring entity.

If continuity is uncertain, keep the identities separate and raise/retain an entity-resolution exception. False merges are more damaging than temporary unresolved relationships because they contaminate historical observations across periods.

## Acquisition versus merger

An acquisition does **not** imply identity collapse. The acquired entity may continue indefinitely as a subsidiary, brand or legal company. Store ownership/control as a relationship and preserve both IDs.

A merger may have either:

1. a surviving existing identity, or
2. a newly formed resulting identity.

The lifecycle participant model supports both without rewriting historical observations.

## Historical observations

Observations continue to point to the immutable identity that was resolved for the source period. A later rename or transaction must not rewrite old observations to a new name or successor ID.

Serving/UI layers may display the current name and "formerly known as" names while retaining the original identity and source-period label for auditability.

## Search and directory behavior

Search should match:

- current canonical names;
- former canonical/legal/trading/marketed names;
- approved abbreviations/program codes;
- permitted tenant-private aliases within that tenant;
- external identifiers;
- predecessor/successor and M&A relationships.

Search results should resolve to the durable entity ID and show relationship/history context rather than returning separate duplicate entities for every historical name.

## Privacy and tenancy

A private customer document can contain an alias or codename that another customer has never seen. That label must not become globally discoverable merely because both tenants resolve to the same `global_company_id` or `global_fund_id`.

`tenant_entity_name` therefore carries `tenant_id`, optional source-reference lineage, confidence and review status, and is protected by forced RLS. Promotion from tenant-private alias to the global name registry must be an explicit governed decision supported by non-confidential/public or otherwise permitted evidence.

## Invariants

- Immutable IDs are joins; names are never joins.
- IDs are never recycled after rename, acquisition, merger, split, dissolution or deletion.
- A rename does not create a new entity by itself.
- An acquisition does not merge identities by itself.
- A split/merger can have multiple participants; the model must not assume one predecessor and one successor.
- Historical names and identifiers remain queryable.
- Tenant-private aliases remain tenant scoped.
- Source observations are never rewritten solely because current entity metadata changed.
- Ambiguous continuity remains explicit rather than being guessed.