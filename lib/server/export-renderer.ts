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

function csvCell(value: ExportCell | undefined): string {
  const raw = neutralizeFormula(value, text(value));
  if (/[",\r\n]/.test(raw)) return `"${raw.replaceAll('"', '""')}"`;
  return raw;
}

export function renderCsv(rows: readonly ExportRow[]): Buffer {
  const lines = [
    EXPORT_COLUMNS.join(","),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",")),
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
  const renderCell = (value: ExportCell | undefined, reference: string) => {
    if (value == null) return `<c r="${reference}" t="inlineStr"><is><t></t></is></c>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
  };

  const header = `<row r="1">${EXPORT_COLUMNS.map((column, index) => renderCell(column, `${excelColumn(index)}1`)).join("")}</row>`;
  const body = rows.map((row, rowIndex) => {
    const number = rowIndex + 2;
    return `<row r="${number}">${EXPORT_COLUMNS.map((column, index) => renderCell(row[column], `${excelColumn(index)}${number}`)).join("")}</row>`;
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
  const columnData = EXPORT_COLUMNS.map((name) => {
    if (name === "value_number" || name === "version") {
      return {
        name,
        data: rows.map((row) => row[name] == null || row[name] === "" ? null : Number(row[name])),
        type: "DOUBLE" as const,
      };
    }
    return {
      name,
      data: rows.map((row) => row[name] == null ? null : String(row[name])),
      type: "STRING" as const,
    };
  });
  const arrayBuffer = parquetWriteBuffer({ columnData });
  return Buffer.from(arrayBuffer);
}

export function renderExport(format: "csv" | "xlsx" | "parquet", rows: readonly ExportRow[]): RenderedExport {
  if (format === "csv") return { bytes: renderCsv(rows), contentType: "text/csv; charset=utf-8", extension: "csv" };
  if (format === "xlsx") return {
    bytes: renderXlsx(rows),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
  return { bytes: renderParquet(rows), contentType: "application/vnd.apache.parquet", extension: "parquet" };
}
