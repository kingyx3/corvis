import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISPLAY } from "../../modules/workspace/domain/display-preferences.ts";
import { displayDate, displayNumberFormatter, displayValue, setDisplayPreferences } from "./display-format.ts";

const globals = globalThis as Record<string, unknown>;

test("display preferences remain server-safe and update browser presentation formatting", () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globals, "window");
  const previousWindow = globals.window;
  delete globals.window;
  try {
    setDisplayPreferences({ timeZone: "UTC", dateFormat: "iso", numberFormat: "de-DE" });
    assert.equal(displayNumberFormatter({ maximumFractionDigits: 1 }).format(1234.5), "1,234.5");

    globals.window = {};
    setDisplayPreferences({ timeZone: "UTC", dateFormat: "iso", numberFormat: "de-DE" });
    assert.equal(displayNumberFormatter().format(1234.5), "1.234,5");
    assert.equal(displayDate("2026-10-01"), "2026-10-01");
    assert.equal(displayDate("2026-10-01T12:34:56Z", { timeStyle: "short" }), "2026-10-01 12:34");
    assert.equal(displayValue(1234.5), "1.234,5");
    assert.equal(displayValue("1234.50"), "1.234,50");

    setDisplayPreferences(DEFAULT_DISPLAY);
  } finally {
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
  }
});
