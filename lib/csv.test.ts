import assert from "node:assert/strict";
import test from "node:test";
import { neutraliseSpreadsheetFormula, toCsv } from "./csv.ts";

test("cells that a spreadsheet would evaluate as formulas are prefixed with a single quote", () => {
  for (const value of ["=HYPERLINK(\"http://x\")", "+SUM(A1)", "-2+3", "@cmd", "\t=1", "\r=1", "-A1"]) {
    assert.equal(neutraliseSpreadsheetFormula(value), `'${value}`, value);
  }
});

test("ordinary text and plain numbers, including negatives, are left intact", () => {
  for (const value of ["Acme Fund II", "12.5", "-12.5", "+3", "-1,200", "-4.2%", "", "a=b"]) {
    assert.equal(neutraliseSpreadsheetFormula(value), value, value);
  }
});

test("toCsv quotes every cell, escapes quotes and neutralises formulas", () => {
  assert.equal(toCsv([["Company", "Value"], ['=cmd|"/c calc"!A1', "-5%"]]), '"Company","Value"\n"\'=cmd|""/c calc""!A1","-5%"');
});
