import { readFile } from "node:fs/promises";
import { evaluateCustomerAcceptance, validateCustomerImplementationManifest, type CustomerAcceptanceEvidence } from "../lib/server/customer-implementation.ts";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [manifestPath, evidencePath] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: node scripts/customer-implementation.ts <manifest.json> [acceptance-evidence.json]");
  process.exitCode = 2;
} else {
  try {
    const validation = validateCustomerImplementationManifest(await readJson(manifestPath));
    const output: Record<string, unknown> = { manifest: { valid: validation.valid, errors: validation.errors } };
    if (!validation.valid) {
      console.log(JSON.stringify(output, null, 2));
      process.exitCode = 1;
    } else if (evidencePath) {
      const evidence = await readJson(evidencePath) as CustomerAcceptanceEvidence;
      const scorecard = evaluateCustomerAcceptance(evidence);
      output.acceptance = scorecard;
      console.log(JSON.stringify(output, null, 2));
      if (scorecard.status !== "ready") process.exitCode = 1;
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
