# Data Retention & Secure Deletion

## Principles
Retention is tenant- and data-class-aware, contractually governed and evidence-producing. A global identity match never permits deletion, retention or reuse decisions to cross tenant boundaries.

## Baseline classes
| Data class | Default baseline | Deletion behavior |
| --- | --- | --- |
| Source documents / immutable artifact versions | 7 years unless contract/policy differs | controlled object deletion after legal/contract retention and Object Lock expiry; record deletion evidence |
| Upload quarantine | ≤ 3 days | automatic lifecycle cleanup; malicious/quarantined artifacts may be retained longer only under incident/security policy |
| Candidate / extraction / canonical records | align to source/customer contract | logical + physical deletion/reconstruction rules by layer |
| Published snapshots / review history | align to customer contract and audit requirements | supersede/version; hard deletion only under approved workflow |
| Audit/security events | 7 years baseline | restricted deletion under approved policy |
| Generated exports | 7 days baseline | automatic object lifecycle expiration; metadata retained as required for audit |
| Search index | rebuildable | delete/rebuild immediately after source entitlement/deletion change |
| Backups | documented backup schedule | expire through backup policy; deletion requests track residual backup retention |

Defaults are configuration, not promises. Customer order forms/data-rights records can override them.

## Deletion workflow
1. Authenticate/authorize request and establish tenant + exact resource scope.
2. Check legal hold, incident hold, contractual minimum and Object Lock state.
3. Enumerate source artifact versions, representations, chunks, observations, snapshots, exports and search entries.
4. Block new processing/retrieval for the resource.
5. Delete eligible object-store versions and mark structured records deleted/expired according to system-of-record rules.
6. Rebuild/remove search entries before confirming source retrieval deletion.
7. Record actor, tenant, resource IDs, timestamps, result, residual backup/retention obligations and failures in the audit/evidence system.
8. Verify through a read/search attempt that access is no longer possible.

## Legal / security hold
A hold overrides normal deletion. Holds require a documented authority, scope, start date and release owner. Do not use indefinite holds as a substitute for defining retention.

## Customer termination
Termination executes the same deletion workflow across the tenant inventory after contractual retention obligations are satisfied. Shared global identities remain, but tenant-owned source, facts, relationships and retrieval evidence are deleted without affecting other tenants.

## Evidence
Every deletion request receives a stable request/evidence ID. Completion is not claimed until the executable workflow reports success or explicitly records residual retained copies and why they remain.
