// Fails when a production browser bundle contains demo fixture text.
//
//   npm run build            # NEXT_PUBLIC_CORVIS_DEMO_MODE unset or "false" (the production setting)
//   node scripts/check-bundle-demo-free.ts [dir]   # default: .next/static
//
// The needles are derived from adapters/demo/catalog.ts itself, so new fixtures are covered
// automatically. Run it only against a build made with the demo flag off; a demo build is
// expected to contain them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { documents, fundSnapshots, observations, recentActivity, researchSuggestions } from "../adapters/demo/catalog.ts";

export function demoNeedles(): string[] {
  const values = [
    ...fundSnapshots.map((snapshot) => snapshot.fund),
    ...observations.map((row) => row.company),
    ...documents.map((doc) => doc.name),
    ...recentActivity.map((item) => item.title),
    ...researchSuggestions,
  ];
  // Very short strings would match unrelated bundle text.
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= 8))];
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(js|css|html|json|txt)$/.test(entry)) yield path;
  }
}

export function findDemoLeaks(dir: string, needles = demoNeedles()): Array<{ file: string; needle: string }> {
  const leaks: Array<{ file: string; needle: string }> = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const needle of needles) if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) leaks.push({ file, needle });
  }
  return leaks;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const dir = process.argv[2] ?? ".next/static";
  const leaks = findDemoLeaks(dir);
  if (leaks.length) {
    console.error(`Demo fixtures found in the production bundle (${dir}):`);
    for (const leak of leaks) console.error(`  ${leak.file}: "${leak.needle}"`);
    process.exit(1);
  }
  console.log(`No demo fixtures in ${dir} (${demoNeedles().length} needles checked).`);
}
