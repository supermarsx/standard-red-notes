import { test, expect, type ConsoleMessage } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/stress'

/**
 * REGRESSION GATE: "pressing Tab in the Super editor must NOT hang the app."
 *
 * The Super (Lexical) editor has custom Tab handling (TabIndentationPlugin):
 * Tab inserts a tab in normal text and nests/outdents inside a list. A buggy
 * implementation that pushed a raw '\t' through `selection.insertText` (instead
 * of inserting a proper Lexical TabNode) drove the tab character into the
 * DOM-level segmented/unmergeable text path and FROZE the main thread — pressing
 * Tab made the whole UI hang.
 *
 * A frozen main thread cannot run a `page.evaluate`, so this spec proves
 * non-hang by: focusing the editor, pressing Tab repeatedly (in plain text and
 * inside a list), and after EACH burst asserting the page is still responsive —
 * a follow-up evaluate resolves immediately AND the editor still accepts typed
 * input — all within tight timeouts, with no uncaught page error. If Tab hangs,
 * the keyboard action or the responsiveness probe times out and the test FAILS
 * (loudly) instead of hanging the runner (config timeout=60s, retries=0).
 */

const APP_SHELL = '.main-ui-view, #footer-bar'
const SUPER_EDITABLE = '#super-editor-content'

const IGNORABLE_ERROR = /favicon|ResizeObserver loop|net::ERR_|web access|telemetry|Failed to load resource/i

/**
 * Create a Super note via the live in-page snjs application (same surface the
 * other e2e helpers use) and select it so the Super editor mounts. Returns the
 * created note uuid. The note starts with empty text => an empty Lexical doc.
 */
async function createAndOpenSuperNote(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')

    // NoteType.Super / SuperEditor identifier come from @standardnotes/features;
    // their string values are stable ('super' / 'com.standardnotes.super-editor').
    const template = app.items.createTemplateItem('Note', {
      title: `Tab-hang probe ${Date.now()}`,
      text: '',
      references: [],
      noteType: 'super',
      editorIdentifier: 'com.standardnotes.super-editor',
    })
    const note = await app.mutator.insertItem(template)
    await app.sync.sync({ sourceDescription: 'super-tab-no-hang-seed' })
    // The test opens the note by clicking it in the list (the real user path);
    // no controller plumbing needed here.
    return note.uuid as string
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
}

/**
 * Assert the page main thread is responsive RIGHT NOW: a trivial evaluate must
 * resolve well within the action budget. A frozen main thread (the Tab-hang
 * bug) cannot service this and the await rejects/timeouts.
 */
async function assertResponsive(page: import('@playwright/test').Page, label: string): Promise<void> {
  const marker = `responsive-${Date.now()}-${Math.random()}`
  const echoed = await Promise.race([
    page.evaluate((m) => m, marker),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`page unresponsive after ${label} (evaluate did not resolve in 5s)`)), 5_000),
    ),
  ])
  expect(echoed, `responsiveness probe after ${label}`).toBe(marker)
}

test.describe('Super editor Tab key', () => {
  test('pressing Tab (plain text, repeated, and in a list) never hangs the app', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const consoleErrors: string[] = []
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && !IGNORABLE_ERROR.test(message.text())) {
        consoleErrors.push(message.text())
      }
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(APP_SHELL).first()).toBeVisible({ timeout: 30_000 })
    await waitForApplicationReady(page, 60_000)

    // Create a Super note, then open it by clicking it in the notes list (the
    // real user path). A new note sorts to the top of the list by default.
    await createAndOpenSuperNote(page)

    const editable = page.locator(SUPER_EDITABLE)
    if (!(await editable.isVisible().catch(() => false))) {
      await page.locator('.content-list-item').first().click({ timeout: 15_000 })
    }
    await editable.waitFor({ state: 'visible', timeout: 20_000 })

    await editable.click()
    await assertResponsive(page, 'focus editor')

    // 1) Plain-text Tab: type, then press Tab. (Pre-fix this path did NOT freeze,
    //    but it must keep working after the fix routes tabs through a TabNode.)
    await page.keyboard.type('hello')
    await page.keyboard.press('Tab')
    await assertResponsive(page, 'single Tab in plain text')

    // 2) Repeated Tab: hammer it — an infinite loop would hang on the first, but
    //    pressing several proves termination on every keystroke.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Tab')
    }
    await assertResponsive(page, 'repeated Tab')

    // The editor must still accept input after all those Tabs (not wedged).
    await page.keyboard.type('world')
    await assertResponsive(page, 'typing after Tabs')

    // 3) Tab inside a list — THE path that froze the app. Build a bullet list via
    //    the markdown shortcut ("- "). Tab on the FIRST/only item (un-nestable)
    //    must not hang; then add a SECOND item and Tab to actually nest it — the
    //    legitimate indent path — which must also stay responsive.
    await page.keyboard.press('Enter')
    await page.keyboard.type('- first')
    await page.keyboard.press('Tab') // first item: un-nestable -> safe
    await assertResponsive(page, 'Tab on first (un-nestable) list item')

    await page.keyboard.press('Enter')
    await page.keyboard.type('second')
    await page.keyboard.press('Tab') // second item: nestable -> indents
    await assertResponsive(page, 'Tab nesting a second list item')
    await page.keyboard.press('Shift+Tab') // outdent it back
    await assertResponsive(page, 'Shift+Tab outdenting a nested list item')

    // Final hard responsiveness + typing probe.
    await page.keyboard.type('done')
    const stillThere = await page.evaluate(() => {
      const el = document.getElementById('super-editor-content')
      return el ? el.textContent ?? '' : null
    })
    expect(stillThere, 'editor content element should still be present and readable').not.toBeNull()

    // No uncaught page errors / console errors during the whole Tab flow — an
    // infinite-loop error or a Lexical invariant blow-up would surface here.
    expect(pageErrors, `uncaught page errors during Tab flow:\n${pageErrors.join('\n')}`).toEqual([])
    expect(consoleErrors, `console errors during Tab flow:\n${consoleErrors.join('\n')}`).toEqual([])
  })
})
