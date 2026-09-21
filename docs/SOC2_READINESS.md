# SOC 2 readiness — technical implementation contract

This document is the repository-side companion to the canonical Confluence page [SOC 2 Readiness, Control Mapping & Audit Plan](https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/2523160). Confluence owns control requirements, audit scope, policy, operating evidence and assurance claims. GitHub owns the technical implementation and executable evidence paths.

## Assurance boundary

Corvis is **not** represented by this repository as SOC 2 certified, attested or independently audited. The target is an independently examined SOC 2 Type II report. Until a qualified CPA firm issues the report, all repository and Confluence material must use readiness/mapping language only.

The baseline target includes Security/Common Criteria plus Availability, Confidentiality and Processing Integrity. Privacy is conditional on the auditor-agreed system scope and customer/personal-data commitments.

## Machine-readable readiness map

[`../ops/soc2-controls.json`](../ops/soc2-controls.json) maps the SOC 2 criteria families to Corvis owners, implementation/evidence sources and readiness states. CI tests fail if a required family disappears, if an entry loses ownership/evidence, or if the repository starts claiming an issued report prematurely.

The map intentionally does not copy the AICPA criteria text. The AICPA Trust Services Criteria and SOC 2 Description Criteria remain authoritative for the examination.

## Existing technical controls

The repository already provides substantial audit-supporting implementation:

- protected pull-request/change flow with required CI checks and no configured ruleset bypass;
- deterministic lint/type/unit/build/browser gates, dependency audit, CodeQL and repository-history leak scanning;
- Terraform-managed infrastructure and reviewed environment promotion paths;
- keyless GitHub-to-GCP deployment trust and managed runtime secrets;
- server-authoritative tenant authorization, Postgres RLS and service-identity controls;
- tenant-scoped audit events and privileged-operation attribution;
- append-only/hash-chained control-evidence lifecycle with freshness/escalation logic;
- provider-backed security acceptance contracts for edge/origin and Postgres tenant isolation;
- retention/deletion/legal-hold control foundations;
- versioned SLO/RPO/RTO targets, monitoring IaC and incident/recovery runbooks;
- durable processing, review, reconciliation, lineage and publication controls needed for Processing Integrity evidence.

These controls are useful only when their live/provider evidence is current. Unit tests and design documents do not substitute for operating evidence.

## Remaining audit-readiness work

The technical program is not complete until the following evidence exists for the real production-equivalent system:

1. production-like UAT with live Cloudflare/GCP/Postgres/IdP/provider boundaries;
2. current IdP/JML/MFA and privileged-access review evidence;
3. backup/restore and DR exercise evidence with actual RPO/RTO results;
4. incident-response/tabletop exercise evidence and remediation;
5. vulnerability backlog/remediation-SLA evidence from live scanners and tracking;
6. critical vendor/subprocessor assessment and provider configuration evidence;
7. production-like tenant-isolation, edge/origin, release/promotion and rollback evidence;
8. processing-integrity evidence for replay, correction, reconciliation, lineage and publication;
9. independent security/penetration assessment and verified closure of launch-blocking findings;
10. recurring control evidence over the auditor-agreed Type II observation period.

Company-level controls such as policy approval, training, worker agreements, delegated authority, risk review, insurance and vendor governance are intentionally owned in Confluence/controlled company systems rather than this public repository.

## Evidence handling

Never commit customer data, credentials, penetration-test details, private vendor reports, personnel evidence or confidential audit samples here. Public GitHub may contain schemas, sanitized status, artifact hashes, workflow/run references and non-sensitive control definitions. Restricted evidence belongs in the controlled evidence room and may be referenced by opaque identifier/URI.

## Release rule

A passing build is not a SOC 2 control conclusion. Production release/readiness should fail closed when mandatory technical evidence is missing or stale, but the independent auditor remains responsible for the SOC 2 examination and report. Assurance wording must match the issued report type, scope and period exactly.
