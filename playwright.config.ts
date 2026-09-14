import { defineConfig, devices } from "@playwright/test";

/**
 * Browser acceptance tests run against a production build (`next build && next start`) so they exercise
 * the same server code path as Vercel, with mock inference (USE_MOCK=true) and the Postgres/Auth stack
 * named by .env.local (local Supabase by default). Set E2E_BASE_URL to point at a hosted preview instead.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const hosted = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: process.env.E2E_VIDEO ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: hosted ? undefined : {
    command: "npm run build && npx next start --hostname 127.0.0.1 --port 3100",
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
