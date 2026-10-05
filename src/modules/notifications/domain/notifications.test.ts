import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_CATEGORIES,
  NotificationPreferenceError,
  categoryVisibleTo,
  effectivePreference,
  normalizePreferenceChanges,
  renderEmail,
  safeInline,
  settingsUrl,
  type OutboxCategory,
} from "./notifications.ts";

const analyst = { isAdmin: false, isTenantAdmin: false };
const workspaceAdmin = { isAdmin: true, isTenantAdmin: false };
const orgAdmin = { isAdmin: true, isTenantAdmin: true };
const appUrl = "https://app.corvis.test";

test("categories are visible only to the audience that can receive them", () => {
  const visible = (viewer: typeof analyst) => NOTIFICATION_CATEGORIES.filter((category) => categoryVisibleTo(category, viewer)).map((category) => category.id);
  assert.deepEqual(visible(analyst), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "export_schedule_failed", "role_changed"]);
  assert.deepEqual(visible(workspaceAdmin), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "export_schedule_failed", "source_attention", "role_changed"]);
  assert.deepEqual(visible(orgAdmin), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "export_schedule_failed", "source_attention", "support_access", "security_policy", "tenant_export_approval", "tenant_export_outcome", "deletion_request_approval", "service_account_expiry", "role_changed"]);
});

test("security notices are mandatory and ignore any stored preference", () => {
  for (const category of NOTIFICATION_CATEGORIES.filter((item) => item.mandatory)) {
    assert.deepEqual(effectivePreference(category, { category: category.id, enabled: false, delivery: "daily_digest" }), { enabled: true, delivery: "immediate" });
  }
  const pinned = NOTIFICATION_CATEGORIES.find((item) => item.id === "pinned_fund_published")!;
  assert.deepEqual(effectivePreference(pinned), { enabled: true, delivery: "daily_digest" }, "catalog default applies without a stored row");
  assert.deepEqual(effectivePreference(pinned, { category: pinned.id, enabled: false, delivery: "immediate" }), { enabled: false, delivery: "immediate" });
});

test("preference changes reject mandatory, hidden, duplicate and malformed categories", () => {
  const code = (body: unknown, viewer = analyst) => {
    try { normalizePreferenceChanges(body, viewer); return "ok"; } catch (error) { return (error as NotificationPreferenceError).code; }
  };
  assert.equal(code({ categories: [{ id: "export_ready", enabled: false, delivery: "immediate" }] }), "ok");
  assert.equal(code({ categories: [{ id: "role_changed", enabled: false, delivery: "immediate" }] }), "category_not_configurable");
  assert.equal(code({ categories: [{ id: "security_policy", enabled: false, delivery: "immediate" }] }, orgAdmin), "category_not_configurable", "a policy-change notice cannot be turned off");
  assert.equal(code({ categories: [{ id: "support_access", enabled: false, delivery: "immediate" }] }, orgAdmin), "category_not_configurable");
  assert.equal(code({ categories: [{ id: "source_attention", enabled: false, delivery: "immediate" }] }), "unknown_category", "an analyst cannot configure an admin-only category");
  assert.equal(code({ categories: [{ id: "source_attention", enabled: false, delivery: "immediate" }] }, workspaceAdmin), "ok");
  assert.equal(code({ categories: [{ id: "invitation", enabled: false, delivery: "immediate" }] }), "unknown_category");
  assert.equal(code({ categories: [{ id: "export_ready", enabled: false, delivery: "immediate" }, { id: "export_ready", enabled: true, delivery: "immediate" }] }), "unknown_category");
  assert.equal(code({ categories: [{ id: "export_ready", enabled: "no", delivery: "immediate" }] }), "invalid_request");
  assert.equal(code({ categories: [{ id: "export_ready", enabled: true, delivery: "weekly" }] }), "invalid_request");
  assert.equal(code({ categories: [] }), "invalid_request");
  assert.equal(code([]), "invalid_request");
  // A non-object entry, and an id that is not even a string, are malformed requests or unknown categories, never a crash.
  assert.equal(code({ categories: [null] }), "invalid_request");
  assert.equal(code({ categories: ["export_ready"] }), "invalid_request");
  assert.equal(code({ categories: [{ id: 7, enabled: true, delivery: "immediate" }] }), "unknown_category");
  assert.equal(code({ categories: [{ enabled: true, delivery: "immediate" }] }), "unknown_category");
  assert.equal(code({ categories: [{ id: "data_issue_update", enabled: false, delivery: "daily_digest" }] }), "ok", "data issue updates are optional for everyone");
  assert.equal(code({ categories: [{ id: "review_discussion", enabled: false, delivery: "daily_digest" }] }), "ok", "review assignments and mentions are optional");
});

test("the export approval notice is mandatory and the requester's outcome notice is an organization-admin preference (F10d)", () => {
  const approval = NOTIFICATION_CATEGORIES.find((item) => item.id === "tenant_export_approval")!;
  const outcome = NOTIFICATION_CATEGORIES.find((item) => item.id === "tenant_export_outcome")!;
  assert.equal(approval.mandatory, true, "the four-eyes control needs the other admins to be told");
  assert.equal(approval.audience, "organization_admins");
  assert.equal(outcome.mandatory, false);
  assert.equal(outcome.audience, "organization_admins");
  assert.deepEqual(effectivePreference(outcome), { enabled: true, delivery: "immediate" });
  assert.deepEqual(effectivePreference(outcome, { category: outcome.id, enabled: false, delivery: "daily_digest" }), { enabled: false, delivery: "daily_digest" });
  const code = (id: string, viewer: typeof analyst) => {
    try { normalizePreferenceChanges({ categories: [{ id, enabled: false, delivery: "immediate" }] }, viewer); return "ok"; } catch (error) { return (error as NotificationPreferenceError).code; }
  };
  assert.equal(code("tenant_export_approval", orgAdmin), "category_not_configurable");
  assert.equal(code("tenant_export_outcome", orgAdmin), "ok");
  assert.equal(code("tenant_export_outcome", workspaceAdmin), "unknown_category", "only an Organization Admin can request an export, so only they see the category");
  assert.equal(code("tenant_export_approval", analyst), "unknown_category");
});

test("export notices say what happened in words only, never the reason, a note, a person or any data (F10d)", () => {
  const approval = renderEmail("tenant_export_approval", { event: "approval_needed", reason: "SECRET REASON", requestedBy: "morgan@x.test" }, { appUrl, workspaceName: "Growth Workspace" });
  assert.match(approval.subject, /needs your approval/);
  assert.match(approval.text, /A different Organization Admin must approve it before anything is built/);
  assert.match(approval.text, /in Growth Workspace/);
  assert.match(approval.text, /https:\/\/app\.corvis\.test\/access-self-service/);
  assert.match(approval.text, /cannot be turned off/);
  assert.doesNotMatch(approval.text + approval.html, /SECRET REASON|morgan/);
  assert.doesNotMatch(renderEmail("tenant_export_approval", {}, { appUrl }).text, / in \./, "no workspace name, no dangling phrase");

  const subjects = new Map<string, RegExp>([
    ["approved", /was approved/], ["rejected", /was rejected/], ["ready", /is ready/], ["failed", /could not be built/],
  ]);
  for (const [event, pattern] of subjects) {
    const email = renderEmail("tenant_export_outcome", { event, note: "PRIVATE NOTE", decidedBy: "morgan@x.test" }, { appUrl, workspaceName: "W" });
    assert.match(email.subject, pattern, event);
    assert.match(email.text, /https:\/\/app\.corvis\.test\/access-self-service/);
    assert.ok(email.text.includes(settingsUrl(appUrl)), `${event}: optional, so it links to notification settings`);
    assert.doesNotMatch(email.text + email.html, /PRIVATE NOTE|morgan/, `${event}: no note or person`);
  }
  // An unknown event is described as the failure case rather than rendering raw input.
  assert.match(renderEmail("tenant_export_outcome", { event: "<b>x</b>" }, { appUrl }).subject, /could not be built/);
});

test("the service account expiry notice is mandatory, for Organization Admins only, and in words only (F6d)", () => {
  const category = NOTIFICATION_CATEGORIES.find((item) => item.id === "service_account_expiry")!;
  assert.equal(category.mandatory, true, "an admin cannot opt out of hearing that a credential is about to stop");
  assert.equal(category.audience, "organization_admins");
  const code = (viewer: typeof analyst) => {
    try { normalizePreferenceChanges({ categories: [{ id: "service_account_expiry", enabled: false, delivery: "immediate" }] }, viewer); return "ok"; } catch (error) { return (error as NotificationPreferenceError).code; }
  };
  assert.equal(code(orgAdmin), "category_not_configurable");
  assert.equal(code(workspaceAdmin), "unknown_category");
  assert.equal(code(analyst), "unknown_category");

  const cases: Array<[Record<string, unknown>, RegExp, RegExp]> = [
    [{ subject: "account", window: "warning" }, /service account is about to expire/, /service account in your organization expires within the next 14 days\. Its credentials and access stop working with it/],
    [{ subject: "account", window: "final" }, /service account is about to expire/, /expires within the next 3 days/],
    [{ subject: "credential", window: "warning" }, /API credential is about to expire/, /API credential for a service account in your organization expires within the next 14 days\. Systems that use it will stop/],
    [{ subject: "credential", window: "final" }, /API credential is about to expire/, /expires within the next 3 days/],
    [{ subject: "credential", window: "whenever" }, /API credential is about to expire/, /expires soon\./],
    [{}, /service account is about to expire/, /expires soon\./],
  ];
  for (const [params, subject, line] of cases) {
    const email = renderEmail("service_account_expiry", { ...params, accountName: "Nightly reporting sync", owner: "morgan@x.test", id: "0123" }, { appUrl, workspaceName: "Growth Workspace" });
    assert.match(email.subject, subject);
    assert.match(email.text, line);
    assert.match(email.text, /https:\/\/app\.corvis\.test\/access-self-service/);
    assert.match(email.text, /cannot be turned off/);
    assert.doesNotMatch(email.text + email.html, /Nightly|morgan|0123|Growth Workspace/, "no account name, person, identifier or workspace");
  }
});

test("the deletion approval notice is mandatory, Organization-Admin-only, and says only that an approval is needed (F10e)", () => {
  const approval = NOTIFICATION_CATEGORIES.find((item) => item.id === "deletion_request_approval")!;
  assert.equal(approval.mandatory, true, "the four-eyes control needs the other admins to be told");
  assert.equal(approval.audience, "organization_admins");
  const code = (viewer: typeof analyst) => {
    try { normalizePreferenceChanges({ categories: [{ id: "deletion_request_approval", enabled: false, delivery: "immediate" }] }, viewer); return "ok"; } catch (error) { return (error as NotificationPreferenceError).code; }
  };
  assert.equal(code(orgAdmin), "category_not_configurable");
  assert.equal(code(analyst), "unknown_category");
  const email = renderEmail("deletion_request_approval", { event: "approval_needed", reason: "SECRET REASON", dataClasses: ["financials"], requestedBy: "morgan@x.test" }, { appUrl, workspaceName: "Growth Workspace" });
  assert.match(email.subject, /data deletion needs your approval/);
  assert.match(email.text, /A different Organization Admin must approve it before Corvis acts on it/);
  assert.match(email.text, /in Growth Workspace/);
  assert.match(email.text, /https:\/\/app\.corvis\.test\/access-self-service/);
  assert.match(email.text, /cannot be turned off/);
  assert.doesNotMatch(email.text + email.html, /SECRET REASON|financials|morgan/, "no reason, scope or person");
  assert.doesNotMatch(renderEmail("deletion_request_approval", {}, { appUrl }).text, / in \./, "no workspace name, no dangling phrase");
});

test("every email links back to the app, and optional ones link to notification settings", () => {
  const cases: Array<[OutboxCategory, Record<string, unknown>, boolean]> = [
    ["export_ready", { format: "csv" }, true],
    ["pinned_fund_published", {}, true],
    ["source_attention", { status: "suspended" }, true],
    ["data_issue_update", { status: "corrected" }, true],
    ["review_discussion", { event: "assigned" }, true],
    ["support_access", { status: "pending_ack" }, false],
    ["security_policy", { event: "policy_changed" }, false],
    ["security_policy", { event: "user_signed_out" }, false],
    ["tenant_export_approval", {}, false],
    ["tenant_export_outcome", { event: "ready" }, true],
    ["deletion_request_approval", { event: "approval_needed" }, false],
    ["service_account_expiry", { subject: "account", window: "warning" }, false],
    ["role_changed", { roleName: "viewer" }, false],
    ["digest", { items: [{ category: "export_ready", count: 2 }] }, true],
    ["invitation", { roleName: "analyst", invitationUrl: `${appUrl}/invite?tenantId=t#token`, expiresOn: "2026-10-07" }, false],
  ];
  for (const [category, params, optional] of cases) {
    const email = renderEmail(category, params, { appUrl, workspaceName: "Growth Workspace" });
    assert.ok(email.subject.length > 0 && !/[\r\n]/.test(email.subject), `${category}: single-line subject`);
    assert.match(email.text, /https:\/\/app\.corvis\.test\//, `${category}: links into the app`);
    assert.equal(email.text.includes(settingsUrl(appUrl)), optional, `${category}: settings link only on optional emails`);
    assert.equal(/cannot be turned off/.test(email.text), !optional, `${category}: mandatory notices say so`);
  }
});

test("templates escape and bound untrusted names and never render figures they were not given", () => {
  const email = renderEmail("export_ready", {}, { appUrl, workspaceName: "<SCRIPT>alert(1)</SCRIPT><img src=x onerror=alert(1)>\r\nBcc: x@evil.test" });
  const body = email.html.slice(email.html.indexOf("<body"));
  // Only the template's own tags may appear: no markup from the untrusted name survives, in any case.
  assert.ok(!body.toLowerCase().includes("<script") && !body.toLowerCase().includes("<img"), "untrusted markup is escaped");
  assert.ok(body.includes("&lt;SCRIPT&gt;") && body.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.doesNotMatch(email.text, /\r|\nBcc/);
  assert.equal(safeInline("a\u0000b\nc", 3), "a b");
  const role = renderEmail("role_changed", { roleName: null }, { appUrl, workspaceName: "W" });
  assert.match(role.text, /was removed/);
  assert.match(renderEmail("role_changed", { roleName: "reviewer" }, { appUrl }).text, /Review Analyst/, "raw role keys are never shown");
  const policy = renderEmail("security_policy", { event: "policy_changed" }, { appUrl, workspaceName: "W" });
  assert.match(policy.text, /changed the sign-in and session policy in W/);
  assert.match(policy.text, /cannot be turned off/);
  assert.doesNotMatch(policy.text, /minutes|idle|hours/i, "no policy values or user names in the email");
  const signedOut = renderEmail("security_policy", { event: "user_signed_out" }, { appUrl });
  assert.match(signedOut.subject, /signed out of every session/);
  assert.match(signedOut.text, /\/access-self-service/);
});

test("an invitation or action link must be an absolute https URL", () => {
  assert.throws(() => renderEmail("invitation", { roleName: "analyst", invitationUrl: "javascript:alert(1)" }, { appUrl }));
  assert.throws(() => renderEmail("export_ready", {}, { appUrl: "http://attacker.test" }));
});


test("email metadata respects recipient formats and calendar dates remain calendar dates", () => {
  const displayPreferences = { timeZone: "America/Los_Angeles", dateFormat: "iso" as const, numberFormat: "de-DE" as const };
  const instant = renderEmail("invitation", { invitationUrl: `${appUrl}/invite#token`, expiresAt: "2026-10-01T00:30:00Z" }, { appUrl, displayPreferences });
  assert.match(instant.text, /2026-09-30 17:30/);
  const calendar = renderEmail("invitation", { invitationUrl: `${appUrl}/invite#token`, expiresOn: "2026-10-01" }, { appUrl, displayPreferences });
  assert.match(calendar.text, /2026-10-01/);
  const digest = renderEmail("digest", { items: [{ category: "export_ready", count: 1234 }] }, { appUrl, displayPreferences });
  assert.match(digest.text, /1\.234/);
});

test("digest lines name known categories, fall back for unknown ones and only show counts above one", () => {
  const digest = renderEmail("digest", {
    items: [
      { category: "data_issue_update", count: 3 },
      { category: "export_ready", count: 1 },
      { category: "export_ready" },
      { category: "export_ready", count: 0 },
      { category: "export_ready", count: 1.5 },
      { category: "no_such_category", count: 2 },
    ],
  }, { appUrl });
  assert.match(digest.text, /• Data issue updates \(3\)/);
  assert.equal(digest.text.match(/• Export ready\n/g)?.length, 4, "a missing, zero or fractional count is shown once without a number");
  assert.match(digest.text, /• Update \(2\)/, "an unknown category falls back to a generic label");
  const none = renderEmail("digest", { items: "nope" }, { appUrl });
  assert.doesNotMatch(none.text, /•/, "a malformed item list renders no lines");
});

test("a data issue update email names the new status in words and carries no figure, name or case detail", () => {
  const expectations: Array<[unknown, RegExp]> = [
    ["investigating", /Data Operations is investigating a data issue you reported in Growth Workspace\./],
    ["corrected", /was corrected\. A replacement publication is available\./],
    ["no_change", /reviewed and no change was needed\./],
    ["received", /was updated\./],
    [undefined, /was updated\./],
    [{ nested: true }, /was updated\./],
  ];
  for (const [status, line] of expectations) {
    const email = renderEmail("data_issue_update", { status, fundName: "Secret Fund", value: "$125.0m", caseId: "case-1", comment: "Revenue is wrong" }, { appUrl, workspaceName: "Growth Workspace" });
    assert.equal(email.subject, "Update on a data issue you reported");
    assert.match(email.text, line);
    assert.match(email.text, /https:\/\/app\.corvis\.test\/#\/issues/, "links to the Data issues view, where normal authorization applies");
    assert.ok(email.text.includes(settingsUrl(appUrl)) && email.html.includes("Change notification settings"), "optional, so it links to settings");
    for (const secret of ["Secret Fund", "$125.0m", "case-1", "Revenue is wrong"]) {
      assert.ok(!email.text.includes(secret) && !email.html.includes(secret) && !email.subject.includes(secret), `${secret} must never be emailed`);
    }
  }
  assert.doesNotMatch(renderEmail("data_issue_update", { status: "corrected" }, { appUrl }).text, / in /, "no workspace name, no clause");
});

test("a scheduled export failure email says why in words from a closed set and carries no schedule name, scope, figure or person", () => {
  const expectations: Array<[unknown, RegExp]> = [
    ["owner_inactive", /did not run because your access to it had ended\. The schedule was stopped\./],
    ["export_permission_revoked", /did not run because you no longer have permission to create exports\./],
    ["redistribution_not_permitted", /data rights no longer permit redistribution\./],
    ["scope_not_entitled", /you are no longer entitled to the data in its scope\./],
    ["scope_unavailable", /scope no longer resolves to published data\./],
    ["format_unavailable", /its format is not enabled for your organization\./],
    ["export_failed", /was requested but could not be delivered\./],
    ["something_else", /A scheduled export in Growth Workspace did not run\./],
    [undefined, /A scheduled export in Growth Workspace did not run\./],
  ];
  for (const [reason, line] of expectations) {
    const email = renderEmail("export_schedule_failed", {
      reason, label: "Q3 Hg Genesis 9 revenue", scope: "Position financials · company-77", fundName: "Secret Fund", amount: "EUR 12,500,000", owner: "priya@example.test",
    }, { appUrl, workspaceName: "Growth Workspace" });
    assert.equal(email.subject, "A scheduled Corvis export did not run");
    assert.match(email.text, line);
    assert.match(email.text, /Nothing was exported\./);
    assert.match(email.text, /Open Data delivery: https:\/\/app\.corvis\.test\/\n/, "links back into the app, where normal authorization applies");
    assert.ok(email.text.includes(settingsUrl(appUrl)) && email.html.includes("Change notification settings"), "optional, so it links to settings");
    for (const secret of ["Q3 Hg Genesis 9 revenue", "company-77", "Secret Fund", "12,500,000", "priya"]) {
      assert.ok(!email.text.includes(secret) && !email.html.includes(secret) && !email.subject.includes(secret), `${secret} must never be emailed`);
    }
  }
  const category = NOTIFICATION_CATEGORIES.find((item) => item.id === "export_schedule_failed")!;
  assert.deepEqual([category.mandatory, category.audience, category.defaultEnabled, category.defaultDelivery], [false, "everyone", true, "immediate"]);
  assert.doesNotMatch(renderEmail("export_schedule_failed", { reason: "export_failed" }, { appUrl }).text, / in /, "no workspace name, no clause");
});

test("a review assignment or mention email says which happened in words and carries no item, name or comment text", () => {
  const expectations: Array<[unknown, string, RegExp]> = [
    ["assigned", "A review item was assigned to you", /A review item in Growth Workspace was assigned to you\./],
    ["mentioned", "You were mentioned in a review discussion", /You were mentioned in a discussion on a review item in Growth Workspace\./],
    ["something_else", "Activity on a review item", /new activity on a review item in Growth Workspace that involves you\./],
    [undefined, "Activity on a review item", /new activity on a review item/],
  ];
  for (const [event, subject, line] of expectations) {
    const email = renderEmail("review_discussion", {
      event, subjectId: "obs-4", company: "Northstar Health", fundName: "Secret Fund", comment: "The revenue number is wrong", actor: "priya@example.test", mentionedBy: "priya",
    }, { appUrl, workspaceName: "Growth Workspace" });
    assert.equal(email.subject, subject);
    assert.match(email.text, line);
    assert.match(email.text, /Open Data review: https:\/\/app\.corvis\.test\/#\/review/, "links to Data review, where normal authorization applies");
    assert.ok(email.text.includes(settingsUrl(appUrl)) && email.html.includes("Change notification settings"), "optional, so it links to settings");
    for (const secret of ["obs-4", "Northstar Health", "Secret Fund", "The revenue number is wrong", "priya"]) {
      assert.ok(!email.text.includes(secret) && !email.html.includes(secret) && !email.subject.includes(secret), `${secret} must never be emailed`);
    }
  }
  assert.doesNotMatch(renderEmail("review_discussion", { event: "assigned" }, { appUrl }).text, / in /, "no workspace name, no clause");
  assert.match(renderEmail("digest", { items: [{ category: "review_discussion", count: 2 }] }, { appUrl }).text, /• Review assignments and mentions \(2\)/);
});
