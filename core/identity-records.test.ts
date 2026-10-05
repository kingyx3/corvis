import assert from "node:assert/strict";
import test from "node:test";
import {
  IdentityRecordValidationError,
  emailDomain,
  normalizeDomain,
  normalizeEndSessionEndpoint,
  normalizeIssuer,
  parseTargetTenant,
  parseTenantIdentityCommand,
} from "./identity-records.ts";

const TENANT = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

function refused(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof IdentityRecordValidationError && error.code === code && error.status === 400 && error.name === "IdentityRecordValidationError");
}

test("a domain is stored in one narrow form: lower-case ASCII with at least two labels", () => {
  assert.equal(normalizeDomain("  Acme.COM "), "acme.com");
  assert.equal(normalizeDomain("mail.acme.co.uk"), "mail.acme.co.uk");
  assert.equal(normalizeDomain("xn--bcher-kva.example"), "xn--bcher-kva.example");
  for (const bad of ["localhost", "acme", "*.acme.com", "a@acme.com", "https://acme.com", "acme.com/path", "acme.com:8080", "10.0.0.1", "acme..com", "-acme.com", "acme-.com", "bücher.example", "a b.com", "", "a.b", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`]) {
    refused(() => normalizeDomain(bad), "invalid_domain");
  }
  refused(() => normalizeDomain(42), "invalid_domain");
  refused(() => normalizeDomain(undefined), "invalid_domain");
});

test("the domain of an address is what follows its last @, and an address with no local part has none", () => {
  assert.equal(emailDomain("Person@ACME.com"), "acme.com");
  assert.equal(emailDomain("a@b@acme.com"), "acme.com");
  assert.equal(emailDomain("acme.com"), null);
  assert.equal(emailDomain("@acme.com"), null);
  assert.equal(emailDomain(""), null);
});

test("an OpenID Connect issuer is the https form the verifier compares; a SAML entity id is only checked for shape", () => {
  assert.equal(normalizeIssuer("oidc", "https://IDP.acme.com"), "https://idp.acme.com");
  assert.equal(normalizeIssuer("oidc", " https://idp.acme.com/realms/acme/ "), "https://idp.acme.com/realms/acme");
  assert.equal(normalizeIssuer("oidc", "https://idp.acme.com:443/x"), "https://idp.acme.com/x");
  assert.equal(normalizeIssuer("saml", " urn:acme:idp "), "urn:acme:idp");
  assert.equal(normalizeIssuer("saml", "http://idp.acme.com/metadata"), "http://idp.acme.com/metadata");
  for (const bad of ["http://idp.acme.com", "idp.acme.com", "https://user:pw@idp.acme.com", "https://idp.acme.com?x=1", "https://idp.acme.com/#frag", "https://idp.acme.com//", "https://id p.acme.com", "", "https://idp.acme.com/\u0007", `https://idp.acme.com/${"a".repeat(2048)}`]) {
    refused(() => normalizeIssuer("oidc", bad), "invalid_issuer");
  }
  refused(() => normalizeIssuer("oidc", 7), "invalid_issuer");
  refused(() => normalizeIssuer("saml", "urn:acme idp"), "invalid_issuer");
  refused(() => normalizeIssuer("saml", ""), "invalid_issuer");
  refused(() => normalizeIssuer("saml", "x".repeat(2049)), "invalid_issuer");
  // Percent-encoding can lengthen an issuer past the stored limit, and the stored form never ends with a slash.
  refused(() => normalizeIssuer("oidc", `https://idp.acme.com/${"\u00e9".repeat(400)}`), "invalid_issuer");
  refused(() => normalizeIssuer("oidc", `https://idp.acme.com/${"a".repeat(2020)}//`), "invalid_issuer");
});

test("a target tenant is always stated as a uuid, canonicalised to lower case", () => {
  assert.equal(parseTargetTenant(` ${TENANT.toUpperCase()} `), TENANT);
  refused(() => parseTargetTenant("tenant_demo"), "invalid_tenant");
  refused(() => parseTargetTenant(undefined), "invalid_tenant");
  refused(() => parseTargetTenant(7), "invalid_tenant");
});

test("a verified-domain command states its tenant, a normalised domain, how it was verified, the evidence and why", () => {
  assert.deepEqual(parseTenantIdentityCommand({ kind: "verified_domain_add", tenantId: TENANT, domain: "Acme.com", verificationMethod: "dns_txt", evidence: " ticket-12 ", reason: " Customer asked " }),
    { kind: "verified_domain_add", tenantId: TENANT, domain: "acme.com", verificationMethod: "dns_txt", evidence: "ticket-12", reason: "Customer asked" });
  assert.deepEqual(parseTenantIdentityCommand({ kind: "verified_domain_remove", tenantId: TENANT, domain: "acme.com", reason: "Domain sold" }),
    { kind: "verified_domain_remove", tenantId: TENANT, domain: "acme.com", reason: "Domain sold" });
  const add = { kind: "verified_domain_add", tenantId: TENANT, domain: "acme.com", verificationMethod: "operator_attested", evidence: "contract clause 4", reason: "Contract signed" };
  assert.equal(parseTenantIdentityCommand(add).kind, "verified_domain_add");
  refused(() => parseTenantIdentityCommand({ ...add, verificationMethod: "whois" }), "invalid_verification_method");
  refused(() => parseTenantIdentityCommand({ ...add, verificationMethod: undefined }), "invalid_verification_method");
  refused(() => parseTenantIdentityCommand({ ...add, evidence: "x" }), "invalid_evidence");
  refused(() => parseTenantIdentityCommand({ ...add, evidence: 5 }), "invalid_evidence");
  refused(() => parseTenantIdentityCommand({ ...add, evidence: "a".repeat(1001) }), "invalid_evidence");
  refused(() => parseTenantIdentityCommand({ ...add, evidence: "bad\u0007text" }), "invalid_evidence");
  refused(() => parseTenantIdentityCommand({ ...add, domain: "*.acme.com" }), "invalid_domain");
  refused(() => parseTenantIdentityCommand({ ...add, reason: "no" }), "invalid_reason");
  refused(() => parseTenantIdentityCommand({ ...add, reason: 5 }), "invalid_reason");
  refused(() => parseTenantIdentityCommand({ ...add, reason: "a".repeat(1001) }), "invalid_reason");
  refused(() => parseTenantIdentityCommand({ ...add, reason: "bad\u2028reason" }), "invalid_reason");
  assert.equal(parseTenantIdentityCommand({ ...add, reason: "two\nlines\tok" }).reason, "two\nlines\tok");
  refused(() => parseTenantIdentityCommand({ ...add, tenantId: undefined }), "invalid_tenant");
  refused(() => parseTenantIdentityCommand({ kind: "verified_domain_remove", tenantId: TENANT, domain: "acme.com" }), "invalid_reason");
});

test("an identity-provider command states every field and the version it is based on", () => {
  const set = { kind: "identity_provider_set", tenantId: TENANT, protocol: "oidc", issuer: "https://IDP.acme.com/", audience: " corvis ", status: "active", enforceTokenBinding: true, idpEnforcesMfa: true, endSessionEndpoint: null, expectedVersion: 2, reason: "Binding on" };
  assert.deepEqual(parseTenantIdentityCommand(set), {
    kind: "identity_provider_set", tenantId: TENANT, protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis",
    status: "active", enforceTokenBinding: true, idpEnforcesMfa: true, endSessionEndpoint: null, expectedVersion: 2, reason: "Binding on",
  });
  assert.equal((parseTenantIdentityCommand({ ...set, protocol: "saml", issuer: "urn:acme", enforceTokenBinding: false }) as { protocol: string }).protocol, "saml");
  assert.equal((parseTenantIdentityCommand({ ...set, status: "pending", enforceTokenBinding: false, expectedVersion: 0 }) as { expectedVersion: number }).expectedVersion, 0);
  refused(() => parseTenantIdentityCommand({ ...set, protocol: "ldap" }), "invalid_protocol");
  refused(() => parseTenantIdentityCommand({ ...set, status: "retired" }), "invalid_status");
  refused(() => parseTenantIdentityCommand({ ...set, enforceTokenBinding: undefined }), "invalid_binding");
  refused(() => parseTenantIdentityCommand({ ...set, enforceTokenBinding: "true" }), "invalid_binding");
  // Binding is only defined for an active OIDC record.
  refused(() => parseTenantIdentityCommand({ ...set, status: "pending" }), "invalid_binding");
  refused(() => parseTenantIdentityCommand({ ...set, status: "disabled" }), "invalid_binding");
  refused(() => parseTenantIdentityCommand({ ...set, protocol: "saml", issuer: "urn:acme" }), "invalid_binding");
  // MFA enforcement and the end-session endpoint are stated every time: true, false or null (not reported); an https URL or null.
  assert.equal((parseTenantIdentityCommand({ ...set, idpEnforcesMfa: false }) as { idpEnforcesMfa: boolean | null }).idpEnforcesMfa, false);
  assert.equal((parseTenantIdentityCommand({ ...set, idpEnforcesMfa: null }) as { idpEnforcesMfa: boolean | null }).idpEnforcesMfa, null);
  refused(() => parseTenantIdentityCommand({ ...set, idpEnforcesMfa: undefined }), "invalid_idp_mfa");
  refused(() => parseTenantIdentityCommand({ ...set, idpEnforcesMfa: "yes" }), "invalid_idp_mfa");
  assert.equal((parseTenantIdentityCommand({ ...set, endSessionEndpoint: " https://IDP.acme.com/logout?x=1 " }) as { endSessionEndpoint: string | null }).endSessionEndpoint, "https://idp.acme.com/logout?x=1");
  refused(() => parseTenantIdentityCommand({ ...set, endSessionEndpoint: undefined }), "invalid_end_session_endpoint");
  refused(() => parseTenantIdentityCommand({ ...set, endSessionEndpoint: "http://idp.acme.com/logout" }), "invalid_end_session_endpoint");
  refused(() => parseTenantIdentityCommand({ ...set, protocol: "saml", issuer: "urn:acme", enforceTokenBinding: false, endSessionEndpoint: "https://idp.acme.com/logout" }), "invalid_end_session_endpoint");
  refused(() => parseTenantIdentityCommand({ ...set, expectedVersion: -1 }), "invalid_version");
  refused(() => parseTenantIdentityCommand({ ...set, expectedVersion: 1.5 }), "invalid_version");
  refused(() => parseTenantIdentityCommand({ ...set, expectedVersion: "1" }), "invalid_version");
  refused(() => parseTenantIdentityCommand({ ...set, issuer: "http://idp.acme.com" }), "invalid_issuer");
  refused(() => parseTenantIdentityCommand({ ...set, audience: "has space" }), "invalid_audience");
  refused(() => parseTenantIdentityCommand({ ...set, audience: "" }), "invalid_audience");
  refused(() => parseTenantIdentityCommand({ ...set, audience: 4 }), "invalid_audience");
  refused(() => parseTenantIdentityCommand({ ...set, audience: "a".repeat(1025) }), "invalid_audience");
  refused(() => parseTenantIdentityCommand({ ...set, reason: undefined }), "invalid_reason");
});

test("anything that is not a command with a known kind is refused", () => {
  refused(() => parseTenantIdentityCommand(null), "invalid_request");
  refused(() => parseTenantIdentityCommand([]), "invalid_request");
  refused(() => parseTenantIdentityCommand("add"), "invalid_request");
  refused(() => parseTenantIdentityCommand({ tenantId: TENANT, kind: "delete_everything" }), "invalid_kind");
  refused(() => parseTenantIdentityCommand({ tenantId: TENANT }), "invalid_kind");
  refused(() => parseTenantIdentityCommand({ kind: "verified_domain_remove" }), "invalid_tenant");
});

test("an end-session endpoint is an https URL without credentials or fragment, in one normalised form", () => {
  assert.equal(normalizeEndSessionEndpoint("https://idp.acme.com"), "https://idp.acme.com/");
  assert.equal(normalizeEndSessionEndpoint("https://idp.acme.com/oauth2/logout?client=corvis"), "https://idp.acme.com/oauth2/logout?client=corvis");
  for (const bad of [7, null, "", "   ", "not a url", "not-a-url", "http://idp.acme.com/logout", "https://user:pw@idp.acme.com/logout", "https://idp.acme.com/logout#frag", "https://idp.acme.com/a b", `https://idp.acme.com/${"a".repeat(2048)}`]) {
    refused(() => normalizeEndSessionEndpoint(bad), "invalid_end_session_endpoint");
  }
  // Whitespace inside is refused before parsing, and a URL that only grows past the bound once normalised is refused too.
  refused(() => normalizeEndSessionEndpoint(`https://idp.acme.com/?${"é".repeat(400)}`), "invalid_end_session_endpoint");
});
