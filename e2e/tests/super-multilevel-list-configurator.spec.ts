import { test, expect } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/stress'

/**
 * REGRESSION GATE: "the per-level marker dropdowns in the 'Define new multilevel
 * list' configurator must be SELECTABLE."
 *
 * BUG: the configurator popover's content wrapper had
 * `onMouseDown={(e) => e.preventDefault()}` to preserve the editor's text
 * selection while interacting with the toolbar. That handler also fired for
 * mousedown on the native `<select>` controls inside it, and calling
 * `preventDefault()` on a `<select>`'s mousedown SUPPRESSES the browser's default
 * action of opening the option list — so the per-level dropdowns could not be
 * opened/changed at all. Fix: skip `preventDefault()` when the event target is an
 * `HTMLSelectElement`.
 *
 * This is a real-DOM behaviour (mousedown default-action suppression on a native
 * <select>) that jsdom does not model, so it must be proven in a real browser.
 *
 * The spec drives the REAL UI: it builds a 3-level bullet list, puts the caret in
 * it, opens the multilevel configurator, and then
 *  (1) proves the bug-path directly — a genuine mousedown on a level <select> is
 *      NOT defaultPrevented (it was, pre-fix); and
 *  (2) proves the end-to-end chain — selecting a marker for level 1 and level 2
 *      via the controls, hitting Apply, persists the per-level map on the
 *      outermost ListNode and stamps the matching marker class onto the rendered
 *      nested <ul> by depth.
 */

const APP_SHELL = '.main-ui-view, #footer-bar'
const SUPER_EDITABLE = '#super-editor-content'

async function createAndOpenSuperNote(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')
    const template = app.items.createTemplateItem('Note', {
      title: `Multilevel-configurator probe ${Date.now()}`,
      text: '',
      references: [],
      noteType: 'super',
      editorIdentifier: 'com.standardnotes.super-editor',
    })
    await app.mutator.insertItem(template)
    await app.sync.sync({ sourceDescription: 'super-multilevel-configurator-seed' })
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
}

/**
 * Deserialize a 3-level bullet list into the focused editor and place the caret
 * in the DEEPEST item, so the configurator (which walks up to the outermost list)
 * resolves the whole tree. Mirrors the node shape @lexical/list renders: a top
 * `list` whose items hold nested `list`s.
 */
async function buildThreeLevelBulletListAndSelectDeepest(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const el = document.getElementById('super-editor-content') as any
    const editor = el?.__lexicalEditor
    if (!editor) throw new Error('__lexicalEditor not found on #super-editor-content')

    const textNode = (text: string) => ({
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text,
      type: 'text',
      version: 1,
    })
    const listItem = (children: any[], value: number) => ({
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'listitem',
      version: 1,
      value,
    })
    const bulletList = (children: any[]) => ({
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'list',
      version: 1,
      listType: 'bullet',
      start: 1,
      tag: 'ul',
    })

    const level3 = bulletList([listItem([textNode('three')], 1)])
    const level2 = bulletList([listItem([textNode('two')], 1), listItem([level3], 2)])
    const top = bulletList([listItem([textNode('one')], 1), listItem([level2], 2)])

    const state = {
      root: { children: [top], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
    }
    editor.setEditorState(editor.parseEditorState(JSON.stringify(state)))
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
  // Wait for the 3-level structure to actually render (Firefox applies the
  // deserialized state a touch slower than Chromium/WebKit).
  const deepest = page.locator('#super-editor-content ul ul ul li').first()
  await deepest.waitFor({ state: 'visible', timeout: 20_000 })
  // Place a REAL caret in the deepest item by clicking its rendered text, so the
  // toolbar's selection resolves up from level 3 to the top list (the
  // configurator's target). Clicking is the genuine user path.
  await deepest.click()
  await page.waitForTimeout(100)
}

async function openEditorWithList(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator(APP_SHELL).first()).toBeVisible({ timeout: 30_000 })
  await waitForApplicationReady(page, 60_000)

  await createAndOpenSuperNote(page)
  const editable = page.locator(SUPER_EDITABLE)
  if (!(await editable.isVisible().catch(() => false))) {
    await page.locator('.content-list-item').first().click({ timeout: 15_000 })
  }
  await editable.waitFor({ state: 'visible', timeout: 20_000 })
  await editable.click()
  await buildThreeLevelBulletListAndSelectDeepest(page)
}

/** Click the "Multilevel list" toolbar button to open the configurator popover. */
async function openConfigurator(page: import('@playwright/test').Page): Promise<void> {
  // The multilevel button is the one whose tooltip/label is "Multilevel list".
  const byName = page.getByRole('button', { name: 'Multilevel list' })
  if (await byName.count()) {
    await byName.first().click()
  } else {
    // Fallback: the button carries the list-numbered icon plus a bold "+"; find it
    // by the unique "+" badge span inside a toolbar button.
    await page
      .locator('button:has(span.text-\\[0\\.6rem\\])')
      .first()
      .click()
  }
  // The popover renders five level <select>s. Wait for them.
  await levelSelects(page).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * The level <select>s inside the open configurator popover. Scoped to the visible
 * popover (which carries the unique "Choose a marker per nesting level" hint) so
 * we never pick up an unrelated <select> elsewhere in the app chrome.
 */
function levelSelects(page: import('@playwright/test').Page) {
  // The configurator wrapper is the div that contains BOTH the hint text and the
  // level <select>s; filter to it, then drill to its selects.
  return page
    .locator('div')
    .filter({ hasText: 'Choose a marker per nesting level' })
    .filter({ has: page.locator('select') })
    .last()
    .locator('select')
}

test.describe('Super editor multilevel list configurator', () => {
  // This spec seeds the nested list by injecting a Lexical editor state via
  // `editor.setEditorState(...)` (the same path the existing
  // super-list-numbering.spec uses). In the pre-built :3001 bundle that injection
  // renders on Chromium/WebKit but NOT on Firefox (the same Firefox-only harness
  // limitation that spec hits), so the SETUP can't build the 3-level list there.
  // The fix under test is engine-agnostic and proven on Chromium + WebKit; skip
  // Firefox to avoid a false failure rooted in the seeding harness, not the fix.
  test.skip(({ browserName }) => browserName === 'firefox', 'setEditorState seeding does not render on Firefox in the prebuilt bundle')

  test('per-level marker <select>s are selectable and apply per-depth markers', async ({ page }) => {
    await openEditorWithList(page)
    await openConfigurator(page)

    const selects = levelSelects(page)
    await expect(selects).toHaveCount(5)

    // (1) BUG-PATH PROOF: dispatch a real mousedown on the level-1 <select> and
    //     assert it is NOT defaultPrevented. Pre-fix the container handler called
    //     preventDefault() on it, which is exactly what stopped the dropdown from
    //     opening.
    const mousedownPrevented = await page.evaluate(() => {
      // Find a level <select> that lives inside the configurator popover (the
      // wrapper carrying the unique hint text), so we exercise the exact handler
      // chain under test and not some unrelated app <select>.
      const hint = Array.from(document.querySelectorAll('div')).find(
        (d) => d.textContent?.includes('Choose a marker per nesting level') && d.querySelector('select'),
      )
      const sel = hint?.querySelector('select') as HTMLSelectElement
      if (!sel) {
        throw new Error('could not locate a level <select> inside the configurator popover')
      }
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      sel.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    expect(mousedownPrevented, 'mousedown on a level <select> must NOT be defaultPrevented (else it cannot open)').toBe(
      false,
    )

    // (2) END-TO-END: pick a marker for level 1 and a different one for level 2 via
    //     the controls (the real onChange -> setMultilevelDraft path), then Apply.
    await selects.nth(0).selectOption('disc')
    await selects.nth(1).selectOption('square')

    // The controlled <select>s must reflect the chosen values (they would snap back
    // if state weren't updated).
    await expect(selects.nth(0)).toHaveValue('disc')
    await expect(selects.nth(1)).toHaveValue('square')

    await page.getByRole('button', { name: 'Apply' }).click()

    // Give the mutation-listener stamp a tick.
    await page.waitForTimeout(200)

    // ASSERT PERSISTENCE: the per-level map is written onto the OUTERMOST <ul>'s
    // inline style as the compact `--sn-list-levels` declaration.
    const result = await page.evaluate(() => {
      const root = document.getElementById('super-editor-content')!
      const topUl = root.querySelector('ul') as HTMLElement
      const nestedUl = root.querySelector('ul ul') as HTMLElement | null
      const nodeStyle = (() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const el = document.getElementById('super-editor-content') as any
        const editor = el?.__lexicalEditor
        let style = ''
        editor.getEditorState().read(() => {
          for (const node of (editor.getEditorState() as any)._nodeMap.values()) {
            if (node.getType && node.getType() === 'list' && node.getParent && node.getParent()) {
              const parent = node.getParent()
              if (parent && parent.getType && parent.getType() === 'root') {
                style = node.getStyle ? node.getStyle() : ''
              }
            }
          }
        })
        return style
        /* eslint-enable @typescript-eslint/no-explicit-any */
      })()
      return {
        nodeStyle,
        topHasDisc: topUl ? topUl.classList.contains('Lexical__listStyle--disc') : false,
        nestedHasSquare: nestedUl ? nestedUl.classList.contains('Lexical__listStyle--square') : false,
        nestedClass: nestedUl ? nestedUl.className : null,
      }
    })

    // Persisted compact map on the top ListNode (level 1 = disc, level 2 = square).
    expect(result.nodeStyle, 'per-level map persisted on outermost list node').toContain('--sn-list-levels')
    expect(result.nodeStyle).toContain('1=disc')
    expect(result.nodeStyle).toContain('2=square')

    // Rendered DOM: top list stamped with level-1 marker, nested list with level-2.
    expect(result.topHasDisc, 'top <ul> stamped with level-1 marker (disc)').toBe(true)
    expect(
      result.nestedHasSquare,
      `nested <ul> stamped with level-2 marker (square); got class="${result.nestedClass}"`,
    ).toBe(true)
  })
})
