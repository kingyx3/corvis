import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTACT_SUPPORT,
  DEFAULT_SUPPORT_CONFIG,
  SUPPORT_SUBJECT,
  buildSupportContext,
  buildSupportRequest,
  helpEntries,
  helpLinks,
  resolveSupportConfig,
  supportConfigFromEnv,
  supportContextLines,
  viewFromLocation,
} from "./support.ts";

const KEYS = ["SUPPORT_EMAIL", "SUPPORT_URL", "DOCS_URL", "STATUS_URL", "RELEASE_NOTES_URL"].map((name) => `NEXT_PUBLIC_CORVIS_${name}`);

function withEnv(values: Record<string, string>, run: () => void): void {
  const previous = KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("an unconfigured deployment falls back to the documented defaults", () => {
  assert.deepEqual(resolveSupportConfig({}), DEFAULT_SUPPORT_CONFIG);
  withEnv({}, () => assert.deepEqual(supportConfigFromEnv(), DEFAULT_SUPPORT_CONFIG));
});

test("valid configuration overrides every default and is read from the NEXT_PUBLIC variables", () => {
  const expected = {
    supportEmail: "help@fund.example.org",
    supportUrl: "https://desk.example.org/new?queue=corvis",
    docsUrl: "https://docs.example.org/corvis",
    statusUrl: "https://status.example.org/",
    releaseNotesUrl: "https://docs.example.org/corvis/releases",
  };
  assert.deepEqual(resolveSupportConfig({ ...expected, supportEmail: "  help@fund.example.org  ", docsUrl: " https://docs.example.org/corvis " }), expected);
  withEnv({
    NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL: expected.supportEmail,
    NEXT_PUBLIC_CORVIS_SUPPORT_URL: expected.supportUrl,
    NEXT_PUBLIC_CORVIS_DOCS_URL: expected.docsUrl,
    NEXT_PUBLIC_CORVIS_STATUS_URL: expected.statusUrl,
    NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL: expected.releaseNotesUrl,
  }, () => assert.deepEqual(supportConfigFromEnv(), expected));
});

test("invalid or unsafe values never reach a link: they fall back to the defaults", () => {
  const config = resolveSupportConfig({
    supportEmail: "not an email",
    supportUrl: "http://desk.example.org/",
    docsUrl: "javascript:alert(1)",
    statusUrl: "https://user:secret@status.example.org/",
    releaseNotesUrl: "relative/path",
  });
  assert.deepEqual(config, DEFAULT_SUPPORT_CONFIG);
  assert.equal("supportUrl" in config, false);
  for (const email of ["a@b", "a b@c.org", "x@y.org?subject=hijack", "<a@b.org>", `${"a".repeat(250)}@b.org`, "", "   "]) {
    assert.equal(resolveSupportConfig({ supportEmail: email }).supportEmail, DEFAULT_SUPPORT_CONFIG.supportEmail, email);
  }
  assert.equal(resolveSupportConfig({ docsUrl: "https://:pw@docs.example.org/" }).docsUrl, DEFAULT_SUPPORT_CONFIG.docsUrl, "a password alone is also rejected");
  assert.equal(resolveSupportConfig({ docsUrl: "mailto:support@example.org" }).docsUrl, DEFAULT_SUPPORT_CONFIG.docsUrl);
  assert.equal(resolveSupportConfig({ docsUrl: "   " }).docsUrl, DEFAULT_SUPPORT_CONFIG.docsUrl);
});

test("the support context keeps only well-formed identifiers and drops everything else", () => {
  assert.deepEqual(buildSupportContext({}), {});
  assert.deepEqual(buildSupportContext({ tenantId: null, workspaceId: undefined }), {});
  assert.deepEqual(
    buildSupportContext({ tenantId: "tenant-1", workspaceId: "ws:acme.main", view: "documents", reference: "1234567890_abc-DEF", correlationId: "3f2a9c1e-77b0-4d52-9f6e-0c1d2e3f4a5b" }),
    { tenantId: "tenant-1", workspaceId: "ws:acme.main", view: "documents", reference: "1234567890_abc-DEF", correlationId: "3f2a9c1e-77b0-4d52-9f6e-0c1d2e3f4a5b" },
  );
  assert.deepEqual(buildSupportContext({ view: "/admin/tenant-health" }), { view: "/admin/tenant-health" });
  assert.deepEqual(
    buildSupportContext({
      tenantId: "Acme Capital LP", // free text: spaces
      workspaceId: "x".repeat(129),
      view: "documents?fund=Alpha&irr=14.2",
      reference: "digest with spaces",
      correlationId: "IRR 14.2%, NAV $1.2m",
    }),
    {},
  );
});

test("fields outside the allow-list can never leak into the context", () => {
  const smuggled = { workspaceId: "ws-1", documentName: "Q3 Fund Alpha capital account.pdf", nav: "1,204,331.20", observations: [{ value: "14.2%" }] } as Record<string, unknown>;
  const context = buildSupportContext(smuggled);
  assert.deepEqual(context, { workspaceId: "ws-1" });
  const request = buildSupportRequest(DEFAULT_SUPPORT_CONFIG, smuggled);
  assert.doesNotMatch(decodeURIComponent(request.href), /Fund Alpha|1,204|14\.2/);
});

test("the view comes from the hash route first, then the path", () => {
  assert.equal(viewFromLocation({ hash: "#/review", pathname: "/" }), "review");
  assert.equal(viewFromLocation({ hash: "#main-content", pathname: "/admin" }), "/admin");
  assert.equal(viewFromLocation({ hash: "", pathname: "/" }), "/");
});

test("context lines are labelled, ordered and omit what is unknown", () => {
  assert.deepEqual(supportContextLines({}), []);
  assert.deepEqual(
    supportContextLines({ tenantId: "t1", workspaceId: "w1", view: "review", reference: "dg1", correlationId: "c1" }),
    ["Workspace ID: w1", "Organization ID: t1", "Current view: review", "Error reference: dg1", "Latest request ID: c1"],
  );
  assert.deepEqual(supportContextLines({ view: "overview" }), ["Current view: overview"]);
});

test("Contact support composes an email with the workspace, view and latest request id pre-filled", () => {
  const request = buildSupportRequest(resolveSupportConfig({ supportEmail: "help@fund.example.org" }), {
    tenantId: "tenant-1", workspaceId: "ws-1", view: "documents", correlationId: "req-42",
  });
  assert.equal(request.channel, "email");
  assert.equal(request.opensInNewTab, false);
  assert.equal(request.subject, SUPPORT_SUBJECT);
  assert.deepEqual(request.context, { tenantId: "tenant-1", workspaceId: "ws-1", view: "documents", correlationId: "req-42" });
  assert.match(request.href, /^mailto:help@fund\.example\.org\?subject=Corvis%20support%20request&body=/);
  const url = new URL(request.href);
  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, "help@fund.example.org");
  assert.equal(url.searchParams.get("subject"), SUPPORT_SUBJECT);
  const body = url.searchParams.get("body")!;
  for (const line of ["Workspace ID: ws-1", "Organization ID: tenant-1", "Current view: documents", "Latest request ID: req-42"]) assert.ok(body.includes(line), line);
  assert.doesNotMatch(body, /Error reference/);
  assert.match(body, /no financial data or documents are attached/i);
  assert.deepEqual(request.contextLines, ["Workspace ID: ws-1", "Organization ID: tenant-1", "Current view: documents", "Latest request ID: req-42"]);
});

test("an error digest is included as the error reference", () => {
  const request = buildSupportRequest(DEFAULT_SUPPORT_CONFIG, { reference: "2345678901", view: "/", correlationId: "req-1" });
  const body = new URL(request.href).searchParams.get("body")!;
  assert.ok(body.includes("Error reference: 2345678901"));
  assert.ok(body.includes("Latest request ID: req-1"));
  assert.ok(body.includes("Current view: /"));
});

test("with no known context the email still opens, with only the generic body", () => {
  const request = buildSupportRequest(DEFAULT_SUPPORT_CONFIG, {});
  assert.deepEqual(request.contextLines, []);
  const body = new URL(request.href).searchParams.get("body")!;
  assert.doesNotMatch(body, /Workspace ID|Current view|Latest request ID|Error reference/);
});

test("a configured help-desk URL receives the context as query parameters instead of an email", () => {
  const config = resolveSupportConfig({ supportUrl: "https://desk.example.org/new?queue=corvis" });
  const request = buildSupportRequest(config, { tenantId: "t1", workspaceId: "w1", view: "review", reference: "dg1", correlationId: "c1" });
  assert.equal(request.channel, "web");
  assert.equal(request.opensInNewTab, true);
  const url = new URL(request.href);
  assert.equal(url.origin + url.pathname, "https://desk.example.org/new");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    queue: "corvis", subject: SUPPORT_SUBJECT, workspace_id: "w1", organization_id: "t1", view: "review", error_reference: "dg1", request_id: "c1",
  });
  const minimal = new URL(buildSupportRequest(config, {}).href);
  assert.deepEqual(Object.fromEntries(minimal.searchParams), { queue: "corvis", subject: SUPPORT_SUBJECT });
});

test("the Help menu lists Contact support first, then the configured destinations", () => {
  const config = resolveSupportConfig({ docsUrl: "https://docs.example.org/", statusUrl: "https://status.example.org/", releaseNotesUrl: "https://docs.example.org/releases" });
  assert.deepEqual(helpLinks(config).map((link) => [link.id, link.label, link.href]), [
    ["docs", "Documentation", "https://docs.example.org/"],
    ["status", "Service status", "https://status.example.org/"],
    ["release-notes", "Release notes", "https://docs.example.org/releases"],
  ]);
  const email = buildSupportRequest(config, { workspaceId: "w1" });
  const entries = helpEntries(config, email);
  assert.deepEqual(entries.map((entry) => entry.id), ["contact", "docs", "status", "release-notes"]);
  assert.deepEqual(entries[0], { ...CONTACT_SUPPORT, href: email.href, opensInNewTab: false });
  assert.deepEqual(entries.slice(1).map((entry) => entry.opensInNewTab), [true, true, true]);
  const web = buildSupportRequest(resolveSupportConfig({ supportUrl: "https://desk.example.org/" }), {});
  assert.equal(helpEntries(config, web)[0]!.opensInNewTab, true);
  for (const entry of entries) assert.match(entry.keywords, /help/);
});
