import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const PRODUCTION_ROOTS = ["src"];
const STORAGE_BOUNDARY = path.normalize("src/shared/lib/safe-storage.ts");
const DIRECT_STORAGE_ACCESS = /\b(?:(?:window|globalThis)\s*\.\s*)?(?:localStorage|sessionStorage)\s*(?:\.|\[)/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [file];
  }));
  return files.flat();
}

test("production browser storage access is centralized in the hardened boundary", async () => {
  const violations: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of await sourceFiles(root)) {
      const relative = path.normalize(path.relative(process.cwd(), file));
      if (relative === STORAGE_BOUNDARY) continue;
      const source = await readFile(file, "utf8");
      if (DIRECT_STORAGE_ACCESS.test(source)) violations.push(relative);
      DIRECT_STORAGE_ACCESS.lastIndex = 0;
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Direct Web Storage access bypasses src/shared/lib/safe-storage.ts: ${violations.join(", ")}`,
  );
});
