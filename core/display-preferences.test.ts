import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISPLAY, formatDisplayDate, formatDisplayNumber, formatDisplayValue, normalizeDisplayPreferences } from "./display-preferences.ts";
import { normalizeViewConfiguration } from "./saved-views.ts";
test("calendar as-of dates stay on the same day in both extreme time zones", () => {
  for (const timeZone of ["Pacific/Kiritimati", "America/Los_Angeles"]) assert.equal(formatDisplayDate("2026-09-30", { ...DEFAULT_DISPLAY, timeZone, dateFormat: "iso" }), "2026-09-30");
});
test("instant formatting uses the selected time zone and survives DST", () => {
  const preferences = { ...DEFAULT_DISPLAY, dateFormat: "iso" as const, timeZone: "America/Los_Angeles" };
  assert.equal(formatDisplayDate("2026-10-01T00:30:00Z", preferences), "2026-09-30");
  assert.match(formatDisplayDate("2026-03-08T10:30:00Z", preferences, { timeStyle: "short" }), /03:30/);
});
test("number preferences change presentation while leaving source tokens untouched", () => {
  const source = "$1,234.50"; const preferences = { ...DEFAULT_DISPLAY, numberFormat: "de-DE" as const };
  assert.equal(formatDisplayValue(source, preferences), "$1.234,50"); assert.equal(source, "$1,234.50");
  assert.equal(formatDisplayValue("$9,007,199,254,740,993.50", preferences), "$9.007.199.254.740.993,50");
  assert.equal(formatDisplayNumber(1234.5, preferences), "1.234,5");
  assert.equal(formatDisplayValue("fund-1234", preferences), "fund-1234");
});
test("bare years and zero-padded identifiers pass through unchanged while ordinary quantities are still grouped", () => {
  const preferences = { ...DEFAULT_DISPLAY, numberFormat: "de-DE" as const };
  for (const token of ["2026", "1999", "0042", "007"]) assert.equal(formatDisplayValue(token, preferences), token);
  assert.equal(formatDisplayValue("2026"), "2026");
  assert.equal(formatDisplayValue("12345", preferences), "12.345");
  assert.equal(formatDisplayValue("1234"), "1,234");
  assert.equal(formatDisplayValue("0.5"), "0.5");
  assert.equal(formatDisplayValue("0"), "0");
  assert.equal(formatDisplayValue(2026), "2,026", "an actual number is still a quantity");
});
test("invalid zones, formats, and saved-view authorization fields are rejected", () => {
  assert.throws(() => normalizeDisplayPreferences({ ...DEFAULT_DISPLAY, timeZone: "Not/AZone" }));
  assert.throws(() => normalizeViewConfiguration("review", { entitlements: "all" }));
  assert.throws(() => normalizeViewConfiguration("review", { columns: ["private_field"] }));
  assert.throws(() => normalizeViewConfiguration("documents", { columns: [] }));
  assert.deepEqual(normalizeViewConfiguration("review", { sortMode: "confidence", columns: ["Metric", "Value"] }), { sortMode: "confidence", columns: ["Metric", "Value"] });
});
