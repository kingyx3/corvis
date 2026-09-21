# Security assessment rules of engagement

Status: template for completion with the independent assessor before testing production-like UAT.

## Authorized target

Only the explicitly identified Corvis UAT tenant(s), hostnames, cloud project(s), database project and test identities approved for the assessment are authorized. Production, third-party customer systems, unrelated Cloudflare/GCP resources and personal accounts are out of scope unless separately authorized in writing.

## Safety boundaries

- Use synthetic/sanitized test data only.
- Do not intentionally cause persistent denial of service or uncontrolled cost amplification.
- Destructive tests must have a named rollback/recovery procedure and explicit approval before execution.
- Do not retain credentials, tokens, private keys or confidential provider exports in the public repository.
- Stop and notify the Corvis security contact if testing unexpectedly exposes real customer data, production credentials, unrelated tenants, or third-party systems.
- Do not attempt social engineering, physical security testing or testing of provider infrastructure outside the Corvis tenant boundary unless explicitly added to scope.

## Required technical coverage

Test authentication/session handling, tenant isolation/RLS, admin authorization, customer/admin/API/worker runtime boundaries, direct-origin and gateway bypass attempts, upload/source controls, queue and service-identity authentication, webhooks, exports, replay/recovery/correction paths, rate controls, error/log redaction, dependency/configuration weaknesses and privilege escalation.

## Finding lifecycle

Record reproducible evidence, affected boundary, impact, prerequisite access, remediation owner and retest state. Full sensitive evidence remains in the access-controlled assessment repository. Public GitHub issues contain only sanitized reproduction context sufficient for remediation.

## Completion record

Before testing, record assessor organization, named testers, authorized dates, emergency contact, exact UAT targets, test identities, prohibited techniques and evidence destination outside this public repository.
