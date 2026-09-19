import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";

// Supported-browser / responsive matrix. Desktop Chromium is the full-coverage project; the
// additional engine and the mobile viewport run the @matrix subset so CI stays affordable.
// Webkit is skipped when its engine is not installed locally, but always required on CI, where
// the workflow installs it explicitly — a missing engine there is a failure, not a silent skip.
function webkitInstalled(): boolean {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
}

const runWebkit = !!process.env.CI || webkitInstalled();
const target = process.env.CORVIS_E2E_TARGET === "production" ? "production" : "development";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] }, grep: /@matrix/ },
    ...(runWebkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@matrix/ }] : []),
  ],
  webServer: {
    command: target === "production" ? "npm run start" : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      CORVIS_DEMO_MODE: "true",
      NEXT_PUBLIC_CORVIS_DEMO_MODE: "true",
    },
  },
});
