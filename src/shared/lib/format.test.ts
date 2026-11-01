import assert from "node:assert/strict";
import test from "node:test";
import { classifyDocumentFile, formatBytes } from "./format.ts";

test("formatBytes handles zero, byte, kilobyte, megabyte, and capped gigabyte ranges", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1.5 * 1024 ** 2), "1.5 MB");
  assert.equal(formatBytes(2 * 1024 ** 4), "2048.0 GB");
});

test("formatBytes carries into the next unit when rounding reaches 1024", () => {
  assert.equal(formatBytes(1048575), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1.0 MB");
  assert.equal(formatBytes(1024 ** 3 - 1), "1.0 GB");
});

test("formatBytes treats a negative size as 0 instead of producing NaN text", () => {
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(-1024), "0 B");
});

test("formatBytes keeps ordinary sizes unchanged", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(5 * 1024 ** 2 + 512 * 1024), "5.5 MB");
});

test("classifyDocumentFile covers every extension upload-modal.tsx accepts", () => {
  assert.deepEqual(classifyDocumentFile("Fund Report.xlsx"), { tile: "excel", label: "XLS", unit: "sheets" });
  assert.deepEqual(classifyDocumentFile("fund-report.XLS"), { tile: "excel", label: "XLS", unit: "sheets" });
  assert.deepEqual(classifyDocumentFile("holdings.csv"), { tile: "excel", label: "XLS", unit: "sheets" });
  assert.deepEqual(classifyDocumentFile("memo.docx"), { tile: "pdf", label: "DOC", unit: "pages" });
  assert.deepEqual(classifyDocumentFile("deck.pptx"), { tile: "pdf", label: "PPT", unit: "pages" });
  assert.deepEqual(classifyDocumentFile("Q2 Report.pdf"), { tile: "pdf", label: "PDF", unit: "pages" });
  assert.deepEqual(classifyDocumentFile("no-extension"), { tile: "pdf", label: "PDF", unit: "pages" });
});
