import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FEATURE_FLAG_REGISTRY, PORTFOLIO_ATTRIBUTION_FLAG } from "./feature-flags.ts";

type LaunchFlagContract = {
  key: string;
  enforcementFiles: string[];
  enforcementSymbol?: string;
};

// Only features intended to be launch-active belong here. Adding a new launch
// flag requires naming at least one real server-side execution point that reads
// the authoritative Postgres-backed evaluator. Registry-only metadata is not
// considered enforcement.
const LAUNCH_FLAGS: LaunchFlagContract[] = [
  {
    key: PORTFOLIO_ATTRIBUTION_FLAG,
    enforcementFiles: [
      "app/api/v1/portfolios/route.ts",
      "app/api/v1/portfolio-holdings/route.ts",
      "app/api/v1/position-financials/route.ts",
    ],
    enforcementSymbol: "PORTFOLIO_ATTRIBUTION_FLAG",
  },
  {
    key: "exports.parquet_delivery",
    enforcementFiles: ["app/api/v1/exports/route.ts"],
  },
  {
    key: "retrieval.hybrid_search",
    enforcementFiles: ["lib/server/research.ts"],
  },
];

// These flags are intentionally reserved for future/optional surfaces and are
// not launch-enabled. Keeping this explicit prevents an operator from assuming
// a registry row alone means the corresponding product path is protected.
const RESERVED_FLAGS = new Map<string, string>([
  ["ui.delivery_workspace", "customer delivery UI is not being rolled out independently before UAT"],
  ["ui.review_bulk_actions", "bulk review rollout remains reserved until the launch workflow is finalized"],
  ["admin.flag_self_service", "feature governance remains an operator/admin control, not tenant self-service at launch"],
  ["workers.parallel_extraction", "parallel worker fan-out remains disabled until provider capacity is measured in UAT"],
  ["retrieval.model_training_capture", "model-training trace capture is not launch-enabled"],
]);

test("every registered feature flag is explicitly launch-enforced or reserved", () => {
  const launch = new Set(LAUNCH_FLAGS.map((flag) => flag.key));
  const classified = new Set([...launch, ...RESERVED_FLAGS.keys()]);
  const registered = FEATURE_FLAG_REGISTRY.map((definition) => definition.key).sort();
  assert.deepEqual([...classified].sort(), registered);
  for (const flag of LAUNCH_FLAGS) assert.ok(flag.enforcementFiles.length > 0, `${flag.key} needs a server enforcement file`);
  for (const [key, reason] of RESERVED_FLAGS) assert.ok(reason.trim().length > 12, `${key} needs a concrete reserved reason`);
});

test("launch flags are evaluated at their declared server-side execution points", async () => {
  for (const flag of LAUNCH_FLAGS) {
    for (const file of flag.enforcementFiles) {
      const source = await readFile(file, "utf8");
      assert.match(source, /(?:assertFeatureEnabled|isFeatureEnabled)\s*\(/, `${file} must call the authoritative evaluator`);
      const declared = source.includes(`"${flag.key}"`) || source.includes(`'${flag.key}'`) || (flag.enforcementSymbol != null && source.includes(flag.enforcementSymbol));
      assert.ok(declared, `${file} must enforce ${flag.key}`);
    }
  }
});
