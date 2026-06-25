import { test, expect, type ConsoleMessage } from '@playwright/test'

/**
 * "Does the app actually open?" — the most important regression to guard. A
 * broken bundle, a bootstrap exception, or a main-thread freeze (e.g. an
 * infinite Lexical DOM-mutation loop) all manifest as: the React shell never
 * renders. We load the real built app and assert the main UI appears, the page
 * stays responsive, and no fatal page error was thrown.
 */

// Console noise that is NOT a real failure (analytics/telemetry that's expected
// to be unconfigured in a local smoke run, favicon, etc.). Keep this tight.
const IGNORABLE_ERROR = /favicon|ResizeObserver loop|net::ERR_|web access|telemetry|Failed to load resource/i

test.describe('Standard Red Notes web app', () => {
  test('opens: the main UI renders and the page stays responsive', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const consoleErrors: string[] = []
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && !IGNORABLE_ERROR.test(message.text())) {
        consoleErrors.push(message.text())
      }
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // The app mounts React into the body and renders the main shell. If it
    // hangs on load (frozen main thread) or throws during bootstrap, this never
    // appears and the expect times out — which is exactly the failure we want.
    await expect(page.locator('.main-ui-view, #footer-bar').first()).toBeVisible({ timeout: 30_000 })

    // Responsiveness probe: a frozen main thread can't run this evaluate, so a
    // hang that somehow rendered partial DOM still fails here.
    const title = await page.evaluate(() => document.title)
    expect(title.length).toBeGreaterThan(0)

    expect(pageErrors, `Uncaught page errors during bootstrap:\n${pageErrors.join('\n')}`).toEqual([])
    expect(consoleErrors, `Console errors during bootstrap:\n${consoleErrors.join('\n')}`).toEqual([])
  })

  test('the app root is mounted (body is not empty)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // React mounts into a root node it appends to <body>; a non-empty body with
    // real element children means the bundle ran far enough to render.
    await expect
      .poll(async () => page.evaluate(() => document.body.querySelectorAll('div').length), { timeout: 30_000 })
      .toBeGreaterThan(0)
  })

  test('opens fully styled: app.css is loaded and the shell has real layout', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.main-ui-view, #footer-bar').first()).toBeVisible({ timeout: 30_000 })

    // Guards against the "flash of unstyled content / never opens in full" bug:
    // the app stylesheet must actually be loaded AND the mounted root must have
    // computed layout from it (non-zero height), not render before CSS is ready.
    const styled = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets)
      const root = document.getElementById('app-group-root')
      return {
        sheetCount: sheets.length,
        hasAppCss: sheets.some((sheet) => (sheet.href ?? '').includes('app.css')),
        rootHeight: root ? Math.round(root.getBoundingClientRect().height) : 0,
      }
    })
    expect(styled.sheetCount, 'no stylesheets loaded').toBeGreaterThan(0)
    expect(styled.hasAppCss, 'app.css stylesheet not loaded').toBe(true)
    expect(styled.rootHeight, 'app root has no laid-out height (unstyled/blank)').toBeGreaterThan(0)
  })
})
