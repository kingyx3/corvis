import { readFile } from "node:fs/promises";
import { evaluateUatAcceptance, type UatPlan } from "../../src/modules/governance/server/evidence/uat-acceptance.ts";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const [evidencePath, planPath = "ops/uat/acceptance-plan.json"] = process.argv.slice(2);
if (!evidencePath) {
  console.error("usage: node tools/dev/uat-acceptance.ts <uat-evidence.json> [acceptance-plan.json]");
  process.exitCode = 2;
} else {
  try {
    const scorecard = evaluateUatAcceptance(await readJson(planPath) as UatPlan, await readJson(evidencePath));
    console.log(JSON.stringify(scorecard, null, 2));
    if (scorecard.status !== "ready") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
