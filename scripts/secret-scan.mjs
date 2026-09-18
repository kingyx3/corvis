import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", ".next", "node_modules"]);
const ignoredFiles = new Set(["package-lock.json"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".yml", ".yaml", ".md", ".sql", ".tf", ".example"]);
const findings = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (!ignoredFiles.has(entry.name) && (textExtensions.has(extname(entry.name)) || entry.name.startsWith(".env"))) files.push(path);
  }
  return files;
}

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["generic bearer secret", /Bearer\s+[A-Za-z0-9._~-]{40,}/g],
];

for (const file of await walk(root)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8").catch(() => "");
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${rel}: ${name}`);
    pattern.lastIndex = 0;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^(?:CORVIS_[A-Z0-9_]*(?:SECRET|TOKEN|KEY)|NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|KEY))=\S{12,}$/.test(line) && !/(change-me|example|placeholder|development)/i.test(line)) {
      findings.push(`${rel}: populated secret-looking environment value`);
    }
  }
}

if (findings.length) {
  console.error(`Potential committed secrets detected:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}
console.info("Secret scan passed.");
