import { test, expect, type Page } from '@playwright/test'

/**
 * The ACCURATE "app doesn't start" reproduction.
 *
 * The basic open-smoke loads a FRESH browser — no service worker, empty
 * IndexedDB — which is precisely the case that always works. Real users hit a
 * different path: a returning visit where a previously-installed service worker
 * is already CONTROLLING the page (serving cached assets) and IndexedDB holds
 * prior state. That combination is what produced the empty-<body> bug. These
 * tests persist state across reloads inside one browser context so the second
 * and later loads are genuinely service-worker-controlled, then assert the app
 * still mounts.
 */

const APP_SHELL = '.main-ui-view, #footer-bar'

async function assertOpened(page: Page, label: string): Promise<void> {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await expect(page.locator(APP_SHELL).first(), `${label}: app shell never rendered (empty body)`).toBeVisible({
    timeout: 30_000,
  })
  const rootChildren = await page.evaluate(() => {
    const root = document.getElementById('app-group-root')
    return root ? root.childElementCount : -1
  })
  expect(rootChildren, `${label}: #app-group-root has no children (blank page)`).toBeGreaterThan(0)
  expect(pageErrors, `${label}: uncaught page errors\n${pageErrors.join('\n')}`).toEqual([])
}

test.describe('Returning visitor (service-worker-controlled + persisted state)', () => {
  test('opens on the first visit, then on repeat visits once the SW controls the page', async ({ page }) => {
    // 1) First visit — installs the service worker and creates IndexedDB.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await assertOpened(page, 'first visit')

    // Wait until the service worker is actually activated, so the NEXT load is
    // served through it (the returning-user path that previously broke).
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready
      }
    })

    // 2) Repeat visits — now a controlling SW serves the shell and IndexedDB has
    // state. Reload several times; the app must keep opening, not go blank.
    for (let visit = 2; visit <= 4; visit += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      const controlled = await page.evaluate(
        () => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      )
      await assertOpened(page, `repeat visit #${visit} (sw-controlled=${controlled})`)
    }
  })

  test('opens after a full reopen (new page) with the SW already installed', async ({ context }) => {
    // Prime: install the SW in one page, then close it.
    const primer = await context.newPage()
    await primer.goto('/', { waitUntil: 'domcontentloaded' })
    await primer.locator(APP_SHELL).first().waitFor({ state: 'visible', timeout: 30_000 })
    await primer.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready
      }
    })
    await primer.close()

    // Reopen in a brand-new page within the SAME context (shared SW + storage):
    // this is the "I closed the tab and came back later" case.
    const returning = await context.newPage()
    await returning.goto('/', { waitUntil: 'domcontentloaded' })
    await assertOpened(returning, 'reopened tab')
    await returning.close()
  })
})
