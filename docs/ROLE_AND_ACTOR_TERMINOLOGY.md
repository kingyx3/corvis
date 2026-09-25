# Role and actor terminology

This document is the canonical naming contract for human roles and review actors in Corvis. Product copy, API documentation, Confluence, runbooks and future role-management UI must use these terms consistently.

## Canonical terms

| Term | Scope | Meaning |
| --- | --- | --- |
| **Review Analyst** | Tenant/workspace product role | A user of the Corvis workspace who can inspect source evidence, approve/reject/correct observations, work review queues and create governed exports. This is the human-facing name of the existing persisted/application role key `reviewer`. |
| **Data Operations Reviewer** | Corvis internal operations | A Corvis-operated human reviewer responsible for extraction QA, difficult-case review, calibration and operational quality controls. This is not a tenant role and must not be presented as `Review Analyst`. |
| **Resolver** | Corvis internal escalation | A Corvis-operated escalation function for unresolved semantic/reconciliation exceptions, mapping/taxonomy ambiguity and governed learning candidates. |
| **Administrator** | Product role family | A tenant/workspace administrator. Use the specific product label defined by the relevant surface (for example Organization Admin or Workspace Admin) rather than exposing raw machine identifiers. |
| **Analyst** | Tenant/workspace product role | A user who can consume governed data, research and exports but cannot make review decisions. |
| **Viewer** | Tenant/workspace product role | A read-only user. |
| **Approver** | Workflow actor, not a role | A person performing a specific approval step. Use this term for first/second approval state where the underlying role is not the point. |
| **Review** | Workflow/module noun | The governed workflow/module for inspecting and deciding on observations and exceptions. Keep `Review` as the product/module name. |

## Naming rules

1. Never use **Customer Reviewer**, **Customer Analyst**, **Customer Admin**, or similar employment/ownership-prefixed labels in customer-facing product copy. The tenant/workspace context already establishes whose workspace the user is in.
2. Never use unqualified **reviewer** when actor ownership matters. Use **Review Analyst** for the tenant/workspace persona and **Data Operations Reviewer** for Corvis-operated review.
3. Do not expose raw machine role identifiers such as `reviewer`, `accountadmin`, `tenant_admin`, or `read_only` as UI labels. Map them to product labels at the presentation boundary.
4. `reviewer` remains a **legacy machine identifier** for the Review Analyst role for backwards compatibility with existing membership rows, identity claims, tests and integrations. It must not be used as the human-facing name. A future schema migration may rename the identifier independently of product terminology.
5. Corvis staff do not become Review Analysts merely because they perform review work. Cross-tenant/internal review is authorized through Corvis operational controls. Temporary tenant access must use the explicit, audited support-access mechanism.
6. Use **approver** for dual-control/four-eyes state (for example, “awaiting second approver”) unless the product role itself is material to the requirement.
7. Audit events should preserve stable machine identifiers and actor subjects; presentation layers translate role identifiers to canonical labels without rewriting historical evidence.

## Permission boundary

The current `reviewer` machine role corresponds to **Review Analyst** and has `observations:review` but not `snapshots:publish` or `admin:manage`. Publication remains an administrator-controlled action unless the authorization contract is explicitly changed. Corvis Data Operations Reviewer/Resolver authority is separate from tenant role membership and must be governed by internal operating and support-access controls.

## Copy examples

Preferred: “Review Analyst”, “Review queue”, “Awaiting second approver”, “Correct observation”, “Data Operations review required”, “Escalated to Resolver”.

Avoid: “Customer Reviewer”, “Corvis Reviewer” when `Data Operations Reviewer` is meant, “Reviewer role” in customer-facing copy, “reviewer” as a displayed role value, and raw role strings in dropdowns or audit presentation.

## Compatibility note

The product-label change is intentionally decoupled from persisted role-key migration. Existing identity providers, memberships and audit history may continue to carry `reviewer`; authorization code treats it as the Review Analyst capability set. New UI and documentation must use the canonical human-facing terminology above.