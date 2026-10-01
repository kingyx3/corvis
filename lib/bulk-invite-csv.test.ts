import assert from "node:assert/strict";
import test from "node:test";
import { bulkInviteErrorText, parseBulkInviteCsv, tenantAdminRows } from "./bulk-invite-csv.ts";

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

test("parseBulkInviteCsv accepts accountadmin and normalises the legacy workspace_admin alias", () => {
  const csv = `email,role,workspaceId\na@example.com,accountadmin,${workspace}\nb@example.com,workspace_admin,${workspace}\nc@example.com,support,${workspace}\nd@example.com,constructor,${workspace}\n`;
  const { rows, errors } = parseBulkInviteCsv(csv);
  assert.deepEqual(rows.map((row) => [row.row, row.roleName]), [[2, "accountadmin"], [3, "accountadmin"]]);
  assert.deepEqual(errors.map((error) => error.row), [4, 5]);
});

test("parseBulkInviteCsv reports physical line numbers, skipping blank lines", () => {
  const csv = `email,role,workspaceId\r\n\r\na@example.com,analyst,${workspace}\n\n\nbad,analyst,${workspace}\n`;
  const { rows, errors } = parseBulkInviteCsv(csv);
  assert.deepEqual(rows.map((row) => row.row), [3]);
  assert.deepEqual(errors, [{ row: 6, error: "Invalid email, role, workspaceId, or reason" }]);
});

test("parseBulkInviteCsv keeps a quoted multi-line reason as one row and numbers later rows by physical line", () => {
  const csv = `﻿name,email,role,workspaceId,reason\n"Doe, ""J""",a@example.com,analyst,${workspace},"Onboarding batch\r\n\r\nsecond paragraph"\nbad,bad,analyst,${workspace},ok reason\nb@example.com,b@example.com,viewer,${workspace},"fine"\n`;
  const { rows, errors } = parseBulkInviteCsv(csv);
  assert.deepEqual(rows.map((row) => [row.row, row.email, row.name]), [[2, "a@example.com", 'Doe, "J"'], [6, "b@example.com", "b@example.com"]]);
  assert.match(rows[0]!.reason, /^Onboarding batch\r?\n\r?\nsecond paragraph$/);
  assert.deepEqual(errors.map((error) => error.row), [5]);
});

test("parseBulkInviteCsv flags an unterminated quote on the row it starts and keeps the header rules", () => {
  const open = parseBulkInviteCsv(`email,role,workspaceId\na@example.com,analyst,${workspace}\nb@example.com,analyst,"${workspace}\n`);
  assert.deepEqual(open.rows.map((row) => row.row), [2]);
  assert.deepEqual(open.errors, [{ row: 3, error: "Invalid CSV row" }]);
  assert.deepEqual(parseBulkInviteCsv("\n\nemail,role\na,b,c\n").errors, [{ row: 3, error: "Required columns: email, role, workspaceId" }]);
  assert.deepEqual(parseBulkInviteCsv("email,role,workspaceId\n\n").errors, [{ row: 1, error: "CSV requires a header and at least one data row" }]);
});
