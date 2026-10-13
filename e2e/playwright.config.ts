import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke-test config for the Standard Red Notes web app. Points at a running
 * instance (the docker-compose `app` service on :3001 by default; override with
 * APP_URL). These are deliberately black-box: they load the real built bundle in
 * a real browser to catch "the app doesn't open / hangs on load" regressions
 * that jsdom unit tests can't see.
 */
const APP_URL = process.env.APP_URL ?? 'http://localhost:3001'

/**
 * STOCK Firefox — the browser people install, not Playwright's patched build —
 * as a fourth project, present ONLY when `STOCK_FIREFOX` names its executable:
 *
 *   export STOCK_FIREFOX="C:/Program Files/Mozilla Firefox/firefox.exe"
 *   npx playwright test tests/reduced-motion-mermaid-layout.spec.ts --project=stock-firefox
 *
 * Playwright routes the `moz-firefox` channel to its WebDriver BiDi driver, so
 * no geckodriver and no patched browser are involved. The channel is
 * experimental in Playwright and the browser is whatever the machine has, so it
 * is opt-in: with the variable unset this file declares exactly the three
 * projects it always did, and a bare `playwright test` (the weekly matrix) is
 * unchanged.
 *
 * REDUCED MOTION IS SET BY PREFERENCE HERE, NOT BY THE CONTEXT OPTION. Over BiDi
 * Playwright's `reducedMotion: 'reduce'` is silently ignored — measured in stock
 * Firefox 157 on Windows and on Linux: with `ui.prefersReducedMotion` forced to 0
 * the option leaves `matchMedia('(prefers-reduced-motion: reduce)')` false. With
 * no preference at all stock Firefox follows the operating system, which is how
 * a run on a Remote Desktop session looks like the option worked. So the project
 * pins the preference: 1 by default, because reduced motion ON is the owner's
 * configuration and the one every Chromium-only check missed;
 * `STOCK_FIREFOX_REDUCED_MOTION=0` turns it off for the other half of a
 * comparison. A spec that depends on the mode must still ask the page.
 */
const STOCK_FIREFOX = process.env.STOCK_FIREFOX ?? ''
const STOCK_FIREFOX_REDUCED_MOTION = process.env.STOCK_FIREFOX_REDUCED_MOTION === '0' ? 0 : 1

export default defineConfig({
  testDir: './tests',
  // A frozen main thread (e.g. an infinite Lexical mutation loop) must FAIL, not
  // hang the runner — so cap every test and keep retries off so a hang is loud.
  timeout: 60_000,
  expect: { timeout: 30_000 },
  // The suite targets one shared docker-compose stack and several specs mutate
  // instance-wide settings/rate-limit state. Keep files serialized to avoid
  // cross-test 429s or temporary settings bleed.
  workers: 1,
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
  // Run across all three engines: "the app doesn't open" has repeatedly turned
  // out to be environment-specific, so a Chromium-only smoke can miss a
  // Firefox/WebKit-only bootstrap failure.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ...(STOCK_FIREFOX === ''
      ? []
      : [
          {
            name: 'stock-firefox',
            use: {
              ...devices['Desktop Firefox'],
              channel: 'moz-firefox',
              launchOptions: {
                executablePath: STOCK_FIREFOX,
                firefoxUserPrefs: { 'ui.prefersReducedMotion': STOCK_FIREFOX_REDUCED_MOTION },
              },
            },
          },
        ]),
  ],
})
