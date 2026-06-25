import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke-test config for the Standard Red Notes web app. Points at a running
 * instance (the docker-compose `app` service on :3001 by default; override with
 * APP_URL). These are deliberately black-box: they load the real built bundle in
 * a real browser to catch "the app doesn't open / hangs on load" regressions
 * that jsdom unit tests can't see.
 */
const APP_URL = process.env.APP_URL ?? 'http://localhost:3001'

export default defineConfig({
  testDir: './tests',
  // A frozen main thread (e.g. an infinite Lexical mutation loop) must FAIL, not
  // hang the runner — so cap every test and keep retries off so a hang is loud.
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    headless: true,
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
