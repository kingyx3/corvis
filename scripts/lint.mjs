import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const roots = ["app", "adapters", "application", "components", "core", "features", "runtime", "server"];
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const failures = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (allowedExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const rules = [
  { name: "no ts-ignore", pattern: /@ts-ignore/g },
  { name: "no dynamic eval", pattern: /\beval\s*\(/g },
  { name: "no Function constructor", pattern: /\bnew\s+Function\s*\(/g },
  { name: "no dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/g },
  { name: "no console.log in product code", pattern: /console\.log\s*\(/g },
];

for (const dir of roots) {
  for (const file of await walk(join(root, dir))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    for (const rule of rules) {
      if (rule.pattern.test(text)) failures.push(`${rel}: ${rule.name}`);
      rule.pattern.lastIndex = 0;
    }
    if (!rel.startsWith("adapters/demo/") && !rel.startsWith("server/security.ts") && /Northbridge Partners|Alex Morgan/.test(text)) {
      failures.push(`${rel}: hard-coded demo/customer identity outside demo adapter`);
    }
    if (!rel.startsWith("server/config.ts") && !rel.startsWith("runtime/services.ts") && rel !== "proxy.ts" && /process\.env\./.test(text)) {
      failures.push(`${rel}: access environment through the configuration/composition boundary`);
    }
  }
}

if (failures.length) {
  console.error(`Corvis policy lint failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.info("Corvis policy lint passed.");
