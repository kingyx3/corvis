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
  assert.deepEqual(visible(analyst), ["export_ready", "pinned_fund_published", "role_changed"]);
  assert.deepEqual(visible(workspaceAdmin), ["export_ready", "pinned_fund_published", "source_attention", "role_changed"]);
  assert.deepEqual(visible(orgAdmin), ["export_ready", "pinned_fund_published", "source_attention", "support_access", "role_changed"]);
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
});

test("every email links back to the app, and optional ones link to notification settings", () => {
  const cases: Array<[OutboxCategory, Record<string, unknown>, boolean]> = [
    ["export_ready", { format: "csv" }, true],
    ["pinned_fund_published", {}, true],
    ["source_attention", { status: "suspended" }, true],
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
  const email = renderEmail("export_ready", {}, { appUrl, workspaceName: "<script>alert(1)</script>\r\nBcc: x@evil.test" });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
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
