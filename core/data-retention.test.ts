import assert from "node:assert/strict";
import test from "node:test";
import { dataClassLabel, legalHoldScopeLabel, retentionPeriodLabel } from "./data-retention.ts";

test("known data classes get plain names and others are made readable", () => {
  assert.equal(dataClassLabel("financials"), "Financial data");
  assert.equal(dataClassLabel("source_documents"), "Source documents");
  assert.equal(dataClassLabel("audit"), "Audit records");
  assert.equal(dataClassLabel("fund_reports"), "Fund reports");
  assert.equal(dataClassLabel("kyc-records"), "Kyc records");
  assert.equal(dataClassLabel("  _  "), "  _  ", "an identifier with no words is shown as written");
  assert.equal(dataClassLabel(""), "");
});

test("retention periods read as years, months or days, and no period says so", () => {
  assert.equal(retentionPeriodLabel(null), "No fixed retention period");
  assert.equal(retentionPeriodLabel(365), "1 year");
  assert.equal(retentionPeriodLabel(2555), "7 years");
  assert.equal(retentionPeriodLabel(30), "1 month");
  assert.equal(retentionPeriodLabel(90), "3 months");
  assert.equal(retentionPeriodLabel(45), "45 days");
  assert.equal(retentionPeriodLabel(1), "1 day");
  assert.equal(retentionPeriodLabel(0), "0 days");
});

test("a legal hold says what it covers: the whole data class, or the named documents, funds or people within it", () => {
  assert.equal(legalHoldScopeLabel(null, {}), "all data");
  assert.equal(legalHoldScopeLabel("financials", {}), "Financial data");
  assert.equal(legalHoldScopeLabel("source_documents", { documentIds: ["a", "b", "c"] }), "3 documents within source documents");
  assert.equal(legalHoldScopeLabel("source_documents", { documentIds: ["a"], fundIds: ["f1", "f2"], subjectIds: ["p"] }), "1 document, 2 funds, 1 person within source documents");
  assert.equal(legalHoldScopeLabel("financials", { subjectIds: ["p", "q"] }), "2 people within financial data");
  assert.equal(legalHoldScopeLabel(null, { fundIds: ["f1"] }), "1 fund within all data");
  // A scope arriving as JSON text, and one that is malformed, are read safely.
  assert.equal(legalHoldScopeLabel("financials", JSON.stringify({ fundIds: ["f1"] })), "1 fund within financial data");
  assert.equal(legalHoldScopeLabel("financials", "not json"), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", "[1,2]"), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", null), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", { documentIds: "not a list", fundIds: [] }), "Financial data");
});
