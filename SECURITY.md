# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public GitHub issues.

Until a dedicated security contact/channel is configured, repository administrators should use GitHub's private vulnerability reporting/security-advisory workflow when available. If private reporting is not enabled, contact the Corvis security owner through the organization's established private channel.

A useful report includes:

- affected component and version/commit;
- reproduction steps;
- potential tenant/customer-data impact;
- proof of concept where safe;
- suggested mitigation if known.

## Response principles

Corvis will triage reports based on exploitability, confidentiality/integrity/availability impact, tenant-isolation impact and customer-data exposure risk. Confirmed findings should receive an owner, severity, remediation target and verification evidence.

Do not include real customer documents, credentials, tokens or confidential customer data in vulnerability reports.

## Scope priorities

The highest-priority surfaces include authentication and tenant isolation, document upload/processing, source-evidence access, APIs/exports, Snowflake serving controls, AI retrieval, secrets and privileged administration.
