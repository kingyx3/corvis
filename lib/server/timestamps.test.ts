import assert from "node:assert/strict";
import test from "node:test";
import { rfc3339FromPostgres } from "./timestamps.ts";

test("Postgres timestamptz text becomes RFC 3339 without losing precision", () => {
  const cases: Array<[string, string]> = [
    ["2026-09-29 10:11:12.123456+00", "2026-09-29T10:11:12.123456Z"],
    ["2026-09-29 10:11:12+00", "2026-09-29T10:11:12Z"],
    ["2026-09-29 10:11:12.5-08", "2026-09-29T10:11:12.5-08:00"],
    ["2026-09-29 10:11:12+05:30", "2026-09-29T10:11:12+05:30"],
    // unchanged
    ["2026-09-29T10:11:12.123Z", "2026-09-29T10:11:12.123Z"],
    ["2026-09-29", "2026-09-29"],
    ["Revenue 2026-09-29 10:11:12+00 restated", "Revenue 2026-09-29 10:11:12+00 restated"],
    ["infinity", "infinity"],
  ];
  for (const [input, expected] of cases) assert.equal(rfc3339FromPostgres(input), expected, input);
  for (const [input, expected] of cases.slice(0, 4)) assert.equal(Date.parse(input.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")), Date.parse(expected));
});
