import type { SchemaElement } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

export type ExportCell = string | number | boolean | null;
export type ExportRow = Record<string, ExportCell>;

export type RenderedExport = {
  bytes: Buffer;
  contentType: string;
  extension: "csv" | "xlsx" | "parquet";
};

export const EXPORT_COLUMNS = [
  "observation_id",
  "fund_id",
  "company_id",
  "holding_id",
  "instrument_id",
  "metric_code",
  "value_number",
  "value_string",
  "currency",
  "economic_period",
  "report_date",
  "review_state",
  "source_reference_id",
  "document_id",
  "version",
  "updated_at",
] as const;

/**
 * Documented row cap. Exports are rendered fully in memory (a streaming rewrite
 * is out of scope), so the cap bounds worst-case memory: XLSX text and the
 * stored zip are held alongside the row objects. It is also far below XLSX's
 * hard sheet limit of 1,048,576 rows (header included). Exceeding it raises a
 * typed, non-retryable {@link ExportRowLimitError} instead of buffering without bound.
 */
export const EXPORT_MAX_ROWS = 200_000;

export class ExportRowLimitError extends Error {
  readonly code = "export_row_limit_exceeded";
  /** Retrying can never help: the data set is what it is. */
  readonly retryable = false;
  readonly rowCount: number;
  readonly maxRows: number;
  constructor(rowCount: number, maxRows: number = EXPORT_MAX_ROWS) {
    super(`Export has more than the maximum of ${maxRows} rows; narrow the export scope`);
    this.name = "ExportRowLimitError";
    this.rowCount = rowCount;
    this.maxRows = maxRows;
  }
}

export function assertExportRowLimit(rowCount: number, maxRows: number = EXPORT_MAX_ROWS): void {
  if (rowCount > maxRows) throw new ExportRowLimitError(rowCount, maxRows);
}

/** numeric(38,10) columns arrive as decimal strings and are never routed through a JS double. */
export const DECIMAL_SCALE = 10;
export const DECIMAL_PRECISION = 38;
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/** Decimal digits that must survive a double round trip (IEEE 754 keeps 15). */
function significantDigits(decimal: string): number {
  const [whole = "", fraction = ""] = decimal.replace(/^-/, "").split(".");
  const digits = `${whole}${fraction.replace(/0+$/, "")}`.replace(/^0+/, "");
  return digits.length;
}

/** Unscaled integer for DECIMAL(38,10). Excess fractional digits are truncated, never rounded through a float. */
export function decimalToUnscaled(value: ExportCell | undefined): bigint | null {
  if (value == null || value === "") return null;
  let decimal: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    decimal = value.toFixed(DECIMAL_SCALE);
  } else if (isDecimalString(value)) {
    decimal = value;
  } else {
    return null; // e.g. numeric NaN
  }
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = decimal.replace(/^-/, "").split(".");
  const unscaled = BigInt(`${whole}${fraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0")}`);
  if (unscaled.toString().length > DECIMAL_PRECISION) return null;
  return negative ? -unscaled : unscaled;
}

function text(value: ExportCell | undefined): string {
  if (value == null) return "";
  return String(value);
}

/**
 * A text cell that starts with `=`, `+`, `-`, `@`, tab or CR is evaluated as a
 * formula by spreadsheet apps opening the CSV. Text values come from extracted
 * document content, so they are neutralized with a leading apostrophe. Numbers
 * (e.g. a negative `value_number`) are typed values and are left untouched.
 */
function neutralizeFormula(value: ExportCell | undefined, raw: string): string {
  return typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
}

function csvCell(value: ExportCell | undefined, column?: string): string {
  // A negative decimal string is a typed number, not a formula.
  const raw = column === "value_number" && isDecimalString(value) ? value : neutralizeFormula(value, text(value));
  if (/[",\r\n]/.test(raw)) return `"${raw.replaceAll('"', '""')}"`;
  return raw;
}

export function renderCsv(rows: readonly ExportRow[]): Buffer {
  const lines = [
    EXPORT_COLUMNS.join(","),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => csvCell(row[column], column)).join(",")),
  ];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

function xmlEscape(value: string): string {
  return value
    // Control characters (other than tab/LF/CR) and lone surrogates are not
    // legal in XML 1.0 even when escaped; one in extracted text would make the
    // whole workbook unreadable.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function excelColumn(index: number): string {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function worksheetXml(rows: readonly ExportRow[]): string {
  const renderCell = (value: ExportCell | undefined, reference: string, column?: string) => {
    if (value == null) return `<c r="${reference}" t="inlineStr"><is><t></t></is></c>`;
    // Decimal strings become numeric cells only when a double holds them exactly; otherwise the
    // exact text is kept so no precision is silently lost.
    if (column === "value_number" && isDecimalString(value) && significantDigits(value) <= 15) return `<c r="${reference}"><v>${value}</v></c>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
  };

  const header = `<row r="1">${EXPORT_COLUMNS.map((column, index) => renderCell(column, `${excelColumn(index)}1`)).join("")}</row>`;
  const body = rows.map((row, rowIndex) => {
    const number = rowIndex + 2;
    return `<row r="${number}">${EXPORT_COLUMNS.map((column, index) => renderCell(row[column], `${excelColumn(index)}${number}`, column)).join("")}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${header}${body}</sheetData></worksheet>`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; bytes: Buffer };

function zipStored(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.bytes);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + entry.bytes.length;
  }

  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directoryBytes, end]);
}

export function renderXlsx(rows: readonly ExportRow[]): Buffer {
  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`),
    },
    {
      name: "_rels/.rels",
      bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Observations" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`),
    },
    { name: "xl/worksheets/sheet1.xml", bytes: Buffer.from(worksheetXml(rows)) },
  ];
  return zipStored(files);
}

export function renderParquet(rows: readonly ExportRow[]): Buffer {
  // value_number is numeric(38,10): write it as an exact Parquet DECIMAL(38,10)
  // (16-byte fixed-length, unscaled bigint), never as a lossy DOUBLE.
  const schema: SchemaElement[] = [{ name: "root", num_children: EXPORT_COLUMNS.length }];
  const columnData = EXPORT_COLUMNS.map((name) => {
    if (name === "value_number") {
      schema.push({ name, type: "FIXED_LEN_BYTE_ARRAY", type_length: 16, converted_type: "DECIMAL", scale: DECIMAL_SCALE, precision: DECIMAL_PRECISION, repetition_type: "OPTIONAL" });
      return { name, data: rows.map((row) => decimalToUnscaled(row[name])) };
    }
    if (name === "version") {
      schema.push({ name, type: "DOUBLE", repetition_type: "OPTIONAL" });
      return { name, data: rows.map((row) => row[name] == null || row[name] === "" ? null : Number(row[name])) };
    }
    schema.push({ name, type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "OPTIONAL" });
    return { name, data: rows.map((row) => row[name] == null ? null : String(row[name])) };
  });
  const arrayBuffer = parquetWriteBuffer({ columnData, schema });
  return Buffer.from(arrayBuffer);
}

export function renderExport(format: "csv" | "xlsx" | "parquet", rows: readonly ExportRow[]): RenderedExport {
  assertExportRowLimit(rows.length);
  if (format === "csv") return { bytes: renderCsv(rows), contentType: "text/csv; charset=utf-8", extension: "csv" };
  if (format === "xlsx") return {
    bytes: renderXlsx(rows),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
  return { bytes: renderParquet(rows), contentType: "application/vnd.apache.parquet", extension: "parquet" };
}
