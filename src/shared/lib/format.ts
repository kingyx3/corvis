export function formatBytes(bytes: number) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const fixed = (index: number) => (bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0);
  let index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  let text = fixed(index);
  // Rounding can reach the next unit's threshold (1048575 B -> "1024" KB); carry into that unit instead.
  if (Number(text) >= 1024 && index < units.length - 1) { index += 1; text = fixed(index); }
  return `${text} ${units[index]}`;
}

export type DocumentFileKind = { tile: "excel" | "pdf"; label: string; unit: "sheets" | "pages" };
const SPREADSHEET_EXTENSION = /\.(?:xlsx|xls|csv)$/i;
const WORD_EXTENSION = /\.docx$/i;
const SLIDES_EXTENSION = /\.pptx$/i;

/**
 * Classifies an uploaded source document by its file name for the file-tile icon/label and the
 * "N sheets"/"N pages" unit. Covers every extension `upload-modal.tsx` accepts (pdf, xlsx, xls,
 * docx, pptx, csv) — `file-tile` only has "excel" and "pdf" CSS variants, so word/slide documents
 * reuse the "pdf" tile style but keep their own label.
 */
export function classifyDocumentFile(fileName: string): DocumentFileKind {
  if (SPREADSHEET_EXTENSION.test(fileName)) return { tile: "excel", label: "XLS", unit: "sheets" };
  if (WORD_EXTENSION.test(fileName)) return { tile: "pdf", label: "DOC", unit: "pages" };
  if (SLIDES_EXTENSION.test(fileName)) return { tile: "pdf", label: "PPT", unit: "pages" };
  return { tile: "pdf", label: "PDF", unit: "pages" };
}
