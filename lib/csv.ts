// Characters that make Excel, Sheets or LibreOffice treat a cell as a formula
// (OWASP CSV injection guidance), including leading tab / carriage return.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
// Plain numbers ("-12.5", "+3", "-1,200", "-4.2%") are data, not formulas;
// leaving them intact keeps negative financial values numeric in spreadsheets.
const PLAIN_NUMBER = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;

/** Neutralises spreadsheet formula injection by prefixing a single quote. */
export function neutraliseSpreadsheetFormula(value: string): string {
  if (!FORMULA_TRIGGER.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

/** RFC 4180 quoting plus formula neutralisation for every cell. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows
    .map((row) => row.map((value) => `"${neutraliseSpreadsheetFormula(String(value ?? "")).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}
