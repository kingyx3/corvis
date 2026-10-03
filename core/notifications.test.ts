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
  assert.deepEqual(visible(analyst), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "role_changed"]);
  assert.deepEqual(visible(workspaceAdmin), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "source_attention", "role_changed"]);
  assert.deepEqual(visible(orgAdmin), ["export_ready", "pinned_fund_published", "data_issue_update", "review_discussion", "source_attention", "support_access", "role_changed"]);
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

test("every email links back to the app, and optional ones link to notification settings", () => {
  const cases: Array<[OutboxCategory, Record<string, unknown>, boolean]> = [
    ["export_ready", { format: "csv" }, true],
    ["pinned_fund_published", {}, true],
    ["source_attention", { status: "suspended" }, true],
    ["data_issue_update", { status: "corrected" }, true],
    ["review_discussion", { event: "assigned" }, true],
    ["support_access", { status: "pending_ack" }, false],
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
