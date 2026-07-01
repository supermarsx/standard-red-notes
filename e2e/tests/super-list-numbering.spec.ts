import { test, expect } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/stress'

/**
 * REGRESSION GATE: "second-level ordered-list markers must INCREMENT, not repeat
 * the first glyph."
 *
 * BUG: In the Super (Lexical) editor a custom parenthesized number style
 * (`a) b) c)` = lower-alpha-paren, `1) 2) 3)` = decimal-paren) renders the
 * second level as "a) a) a)" instead of "a) b) c)" whenever that level is split
 * across more than one nested `<ol>` (which @lexical/list produces for
 * non-contiguous nested groups). Root cause: `lists.scss` put
 * `counter-reset: sn-list-counter` on the list ELEMENT, so each nested same-class
 * `<ol>` re-resets the counter and restarts at the first glyph.
 *
 * getComputedStyle can't resolve native `::marker` glyphs (returns `normal`) nor
 * custom counter `::before` content (returns the literal `counter(...)` /
 * `counters(...)` expression), so this spec reads markers VISUALLY: it crops a
 * thin strip over each second-level `<li>`'s marker and fingerprints the pixels.
 * Distinct fingerprints == distinct glyphs (incrementing); identical == repeated.
 *
 * CSS counters/::marker do not render in jsdom, so this can only be verified in a
 * real browser — hence an e2e, not a jest unit test.
 *
 * NOTE: the live :3001 bundle is pre-built and predates the Tab-nesting fix
 * (pressing Tab there hangs), so the 2-level list is built by deserializing the
 * exact node tree @lexical/list renders (a top `list` whose items hold nested
 * `list`s) — identical DOM to real editing, stamped identically by ListStylePlugin.
 * The "whole-list paren, split second level" test REPRODUCES the bug on :3001 and
 * goes green only after the lists.scss fix is rebuilt into the bundle.
 */

const APP_SHELL = '.main-ui-view, #footer-bar'
const SUPER_EDITABLE = '#super-editor-content'

async function createAndOpenSuperNote(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')
    const template = app.items.createTemplateItem('Note', {
      title: `List-numbering probe ${Date.now()}`,
      text: '',
      references: [],
      noteType: 'super',
      editorIdentifier: 'com.standardnotes.super-editor',
    })
    await app.mutator.insertItem(template)
    await app.sync.sync({ sourceDescription: 'super-list-numbering-seed' })
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
}

/**
 * Load a 2-level ordered list into the focused Super editor.
 *  - `single`: one contiguous nested `<ol>` of 3 items under top item 2.
 *  - `twoBlocks`: the second level split across TWO sibling nested `<ol>`s (under
 *    top items 2 and 4), 6 items total — the shape that triggers the restart bug.
 */
async function buildTwoLevelOrderedList(
  page: import('@playwright/test').Page,
  twoBlocks: boolean,
): Promise<void> {
  await page.evaluate((flag) => {
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
    const orderedList = (children: any[]) => ({
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'list',
      version: 1,
      listType: 'number',
      start: 1,
      tag: 'ol',
    })

    const nestedA = orderedList([
      listItem([textNode('alpha')], 1),
      listItem([textNode('beta')], 2),
      listItem([textNode('gamma')], 3),
    ])
    const top = flag
      ? orderedList([
          listItem([textNode('first')], 1),
          listItem([nestedA], 2),
          listItem([textNode('third')], 3),
          listItem(
            [
              orderedList([
                listItem([textNode('delta')], 1),
                listItem([textNode('epsilon')], 2),
                listItem([textNode('zeta')], 3),
              ]),
            ],
            4,
          ),
        ])
      : orderedList([listItem([textNode('first')], 1), listItem([nestedA], 2)])

    const state = {
      root: { children: [top], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
    }
    editor.setEditorState(editor.parseEditorState(JSON.stringify(state)))
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, twoBlocks)
  // Give the ListStylePlugin mutation listener a tick to stamp the rendered lists.
  await page.waitForTimeout(200)
}

/**
 * Pixel-fingerprint the marker of every second-level (nested) `<ol>` item across
 * the whole document, in document order. Returns one base64 PNG per item.
 */
async function fingerprintNestedMarkers(page: import('@playwright/test').Page): Promise<string[]> {
  const boxes = await page.evaluate(() => {
    const root = document.getElementById('super-editor-content')!
    const items: HTMLElement[] = []
    for (const ol of Array.from(root.querySelectorAll('ol ol')) as HTMLElement[]) {
      for (const c of Array.from(ol.children)) {
        if (c.tagName === 'LI') items.push(c as HTMLElement)
      }
    }
    return items.map((li) => {
      const r = li.getBoundingClientRect()
      // 30px strip just left of the item box: covers the native outside ::marker
      // and the custom ::before at left:-1.6em.
      return { x: Math.max(0, r.left - 30), y: r.top, width: 30, height: Math.max(8, r.height) }
    })
  })
  const shots: string[] = []
  for (const b of boxes) {
    shots.push((await page.screenshot({ clip: b })).toString('base64'))
  }
  return shots
}

/** Stamp (or clear) a marker class on EVERY `<ol>` in the editor (whole-list apply). */
async function setAllOrderedListClass(
  page: import('@playwright/test').Page,
  cls: string | null,
): Promise<void> {
  await page.evaluate((c) => {
    const root = document.getElementById('super-editor-content')!
    for (const ol of Array.from(root.querySelectorAll('ol')) as HTMLElement[]) {
      ol.className = ol.className.replace(/\bLexical__listStyle--\S+/g, '').trim()
      ol.style.removeProperty('list-style-type')
      if (c) {
        ol.classList.add(c)
        ol.style.listStyleType = 'none'
      }
      void ol.offsetHeight
    }
  }, cls)
  await page.waitForTimeout(50)
}

async function openEditorWithList(page: import('@playwright/test').Page, twoBlocks: boolean): Promise<void> {
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
  await buildTwoLevelOrderedList(page, twoBlocks)
}

test.describe('Super editor 2-level ordered-list numbering', () => {
  test('a single contiguous nested <ol>: native + custom markers all increment (a,b,c)', async ({ page }) => {
    await openEditorWithList(page, false)

    // (a) NATIVE upper-alpha (default .Lexical__ol2) — leave classes as rendered.
    await setAllOrderedListClass(page, null)
    const native = await fingerprintNestedMarkers(page)

    // (b) custom paren + legal, applied to the whole list.
    await setAllOrderedListClass(page, 'Lexical__listStyle--lower-alpha-paren')
    const lowerAlphaParen = await fingerprintNestedMarkers(page)
    await setAllOrderedListClass(page, 'Lexical__listStyle--decimal-paren')
    const decimalParen = await fingerprintNestedMarkers(page)
    await setAllOrderedListClass(page, 'Lexical__listStyle--legal')
    const legal = await fingerprintNestedMarkers(page)

    // eslint-disable-next-line no-console
    console.log(
      'SINGLE-BLOCK distinct:',
      JSON.stringify({
        native: new Set(native).size,
        lowerAlphaParen: new Set(lowerAlphaParen).size,
        decimalParen: new Set(decimalParen).size,
        legal: new Set(legal).size,
      }),
    )

    expect(native.length, 'three nested second-level items').toBe(3)
    expect(new Set(native).size, 'native upper-alpha increments (A,B,C)').toBe(3)
    expect(new Set(lowerAlphaParen).size, 'lower-alpha-paren increments (a),b),c))').toBe(3)
    expect(new Set(decimalParen).size, 'decimal-paren increments (1),2),3))').toBe(3)
    expect(new Set(legal).size, 'legal increments').toBe(3)
  })

  test('a paren second level split across nested <ol>s continues, not restarts (the A,A,A bug)', async ({ page }) => {
    await openEditorWithList(page, true)

    // Apply the paren style to the WHOLE list (top + every nested <ol>), the way a
    // user picks "a) b) c)" for the list. The top <ol> establishes the counter; if
    // the nested <ol>s re-reset it (the bug), block 2 restarts at a) and the 6
    // markers collapse to 3 distinct. The fix keeps one shared counter -> 6 distinct
    // (a,b,c,d,e,f).
    await setAllOrderedListClass(page, 'Lexical__listStyle--lower-alpha-paren')
    const lowerAlphaParen = await fingerprintNestedMarkers(page)
    await setAllOrderedListClass(page, 'Lexical__listStyle--decimal-paren')
    const decimalParen = await fingerprintNestedMarkers(page)

    // eslint-disable-next-line no-console
    console.log(
      'SPLIT-LEVEL distinct (want 6 = continuous; 3 = restarted/A,A,A):',
      JSON.stringify({
        items: lowerAlphaParen.length,
        lowerAlphaParen: new Set(lowerAlphaParen).size,
        decimalParen: new Set(decimalParen).size,
      }),
    )

    expect(lowerAlphaParen.length, 'six nested items across two blocks').toBe(6)
    expect(new Set(lowerAlphaParen).size, 'lower-alpha-paren must continue across blocks (a..f), not restart').toBe(6)
    expect(new Set(decimalParen).size, 'decimal-paren must continue across blocks (1..6), not restart').toBe(6)
  })
})
