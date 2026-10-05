import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getServerConfig, isProductionEnvironment } from "./config.ts";

test("isProductionEnvironment fails closed and agrees with getServerConfig().environment", () => {
  for (const value of ["production", "Production", "PRODUCTION", "staging", "prod", " development"]) {
    assert.equal(isProductionEnvironment(value), true, value);
  }
  for (const value of [undefined, "", "development", "test"]) {
    assert.equal(isProductionEnvironment(value), false, String(value));
  }
  const env = (nodeEnv?: string) => ({ NODE_ENV: nodeEnv }) as unknown as NodeJS.ProcessEnv;
  for (const value of [undefined, "development", "test"]) {
    assert.equal(getServerConfig(env(value)).environment === "production", isProductionEnvironment(value));
  }
  assert.throws(() => getServerConfig(env("Production")), /Missing production configuration/);
});

// src/app/design-system/page.tsx is a server component that needs Next's module graph, so it cannot be imported
// under node --test. Keep every NODE_ENV production gate on the shared helper so none can drift back to `=== "production"`.
test("no production gate compares NODE_ENV to 'production' directly", () => {
  for (const file of ["src/lib/server/request-security.ts", "src/lib/server/postgres-native.ts", "src/proxy.ts", "src/app/design-system/page.tsx"]) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /NODE_ENV\s*[!=]==?\s*["']production["']/, file);
    assert.match(source, /isProductionEnvironment\(/, file);
  }
});
