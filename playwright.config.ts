import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      CORVIS_ENV: "development",
      CORVIS_DEMO_MODE: "true",
      NEXT_PUBLIC_CORVIS_MOCK_API: "true",
      NEXT_PUBLIC_CORVIS_API_BASE: "/api/v1",
      CORVIS_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      CORVIS_SESSION_SECRET: "development-only-e2e-secret-development-only",
    },
  },
});
