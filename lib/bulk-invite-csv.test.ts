import assert from "node:assert/strict";
import test from "node:test";
import { bulkInviteErrorText, tenantAdminRows } from "./bulk-invite-csv.ts";

const workspace = "22222222-2222-4222-8222-222222222222";

test("tenantAdminRows lists only valid tenant_admin rows with their CSV row numbers", () => {
  const csv = `email,role,workspaceId\nboss@example.com,tenant_admin,${workspace}\nanalyst@example.com,analyst,${workspace}\nbad,tenant_admin,${workspace}\n`;
  assert.deepEqual(tenantAdminRows(csv).map((row) => [row.row, row.email]), [[2, "boss@example.com"]]);
  assert.deepEqual(tenantAdminRows(""), []);
});

test("bulkInviteErrorText explains stable codes and passes other text through", () => {
  assert.match(bulkInviteErrorText("tenant_admin_confirmation_required"), /confirm/i);
  assert.match(bulkInviteErrorText("invitation_already_pending"), /already pending/i);
  assert.equal(bulkInviteErrorText("Invalid CSV row"), "Invalid CSV row");
});
