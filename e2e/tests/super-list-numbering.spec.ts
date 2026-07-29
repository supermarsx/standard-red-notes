import { test, expect } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/stress'

/**
 * REGRESSION GATE: "second-level ordered-list markers must count independently
 * of level 1 and continue exactly a..f / 1..6 across split nested blocks."
 *
 * BUG: In the Super (Lexical) editor a custom parenthesized number style
 * (`a) b) c)` = lower-alpha-paren, `1) 2) 3)` = decimal-paren) can render one
 * visual level as several nested `<ol>` blocks (which @lexical/list produces for
 * non-contiguous nested groups). Resetting on every `<ol>` makes each block
 * restart at a); removing nested resets but sharing one counter makes parent
 * items consume the sequence, yielding c,d,e / h,i,j. The correct model is one
 * continuous counter per visual nesting depth.
 *
 * getComputedStyle can't resolve native `::marker` glyphs (returns `normal`) nor
 * custom counter `::before` content (returns the literal `counter(...)` /
 * `counters(...)` expression), so this spec reads markers VISUALLY: it crops a
 * marker-only strip and fingerprints the pixels. For custom counters it then
 * re-renders the same real `::before` box with exact reference strings, proving
 * the resolved sequence rather than merely counting distinct glyphs.
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
const MARKER_REFERENCE_STYLE_ID = 'e2e-super-list-marker-reference'
type ParenthesizedMarker = 'lower-alpha-paren' | 'decimal-paren'

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
async function buildTwoLevelList(
  page: import('@playwright/test').Page,
  twoBlocks: boolean,
  marker?: ParenthesizedMarker,
  mixedTags = false,
): Promise<void> {
  const options: [boolean, ParenthesizedMarker | undefined, boolean] = [twoBlocks, marker, mixedTags]
  await page.evaluate((options) => {
    const [flag, markerValue, mixed] = options
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
    const list = (children: any[], tag: 'ol' | 'ul') => ({
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'list',
      version: 1,
      listType: tag === 'ol' ? 'number' : 'bullet',
      start: 1,
      tag,
    })

    const nestedTag = 'ol'
    const topTag = mixed ? 'ul' : 'ol'
    const nestedA = list(
      [listItem([textNode('alpha')], 1), listItem([textNode('beta')], 2), listItem([textNode('gamma')], 3)],
      nestedTag,
    )
    const top = flag
      ? list(
          [
            listItem([textNode('first')], 1),
            listItem([nestedA], 2),
            listItem([textNode('third')], 3),
            listItem(
              [
                list(
                  [
                    listItem([textNode('delta')], 1),
                    listItem([textNode('epsilon')], 2),
                    listItem([textNode('zeta')], 3),
                  ],
                  nestedTag,
                ),
              ],
              4,
            ),
          ],
          topTag,
        )
      : list([listItem([textNode('first')], 1), listItem([nestedA], 2)], topTag)

    const state = {
      root: { children: [top], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
    }
    editor.setEditorState(editor.parseEditorState(JSON.stringify(state)))
    if (markerValue) {
      editor.update(
        () => {
          for (const node of (editor as any)._pendingEditorState._nodeMap.values()) {
            if (node.getType?.() === 'list' && node.getParent?.()?.getType?.() === 'root') {
              node.getWritable().setStyle(`--sn-list-levels: 1=${markerValue},2=${markerValue}`)
            }
          }
        },
        { discrete: true },
      )
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, options)
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
    for (const list of Array.from(root.querySelectorAll('ol ol, ol ul, ul ol, ul ul')) as HTMLElement[]) {
      for (const c of Array.from(list.children)) {
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

/** Compare resolved custom-counter glyphs against exact text rendered in the same boxes. */
async function expectNestedMarkerSequence(
  page: import('@playwright/test').Page,
  expectedMarkers: string[],
): Promise<void> {
  const rendered = await fingerprintNestedMarkers(page)
  expect(rendered.length, `${expectedMarkers.length} nested marker screenshots`).toBe(expectedMarkers.length)
  const referenceOptions: [string[], string] = [expectedMarkers, MARKER_REFERENCE_STYLE_ID]
  try {
    await page.evaluate((options) => {
      const [markers, styleId] = options
      const items = Array.from(
        document.querySelectorAll('#super-editor-content :is(ol, ul) :is(ol, ul) > li'),
      ) as HTMLElement[]
      if (items.length !== markers.length) {
        throw new Error(`Expected ${markers.length} nested marker references, found ${items.length} list items`)
      }
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
        #super-editor-content :is(ol, ul) :is(ol, ul) > li[data-e2e-marker-reference]::before {
          content: attr(data-e2e-marker-reference) !important;
        }
      `
      document.head.append(style)
      items.forEach((item, index) => item.setAttribute('data-e2e-marker-reference', markers[index]))
    }, referenceOptions)
    expect(rendered, `resolved markers must be exactly ${expectedMarkers.join(', ')}`).toEqual(
      await fingerprintNestedMarkers(page),
    )
  } finally {
    await page.evaluate((styleId) => {
      const root = document.getElementById('super-editor-content')
      for (const item of Array.from(root?.querySelectorAll('[data-e2e-marker-reference]') ?? [])) {
        item.removeAttribute('data-e2e-marker-reference')
      }
      document.getElementById(styleId)?.remove()
    }, MARKER_REFERENCE_STYLE_ID)
  }
}

/** Verify persisted multilevel styling survives a real Lexical reconciliation. */
async function expectPersistedMarker(
  page: import('@playwright/test').Page,
  marker: ParenthesizedMarker,
): Promise<void> {
  const className = `Lexical__listStyle--${marker}`
  const allListsAreStamped = (expectedClass: string) => {
    const lists = Array.from(document.querySelectorAll('#super-editor-content ol, #super-editor-content ul'))
    return (
      lists.length > 1 &&
      lists.every(
        (list) => list.classList.contains(expectedClass) && (list as HTMLElement).style.listStyleType === 'none',
      )
    )
  }
  await page.waitForFunction(allListsAreStamped, className)

  const persisted = await page.evaluate((expectedMarker) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const el = document.getElementById('super-editor-content') as any
    const editor = el?.__lexicalEditor
    if (!editor) throw new Error('__lexicalEditor not found on #super-editor-content')
    let topStyle = ''
    editor.getEditorState().read(() => {
      for (const node of (editor.getEditorState() as any)._nodeMap.values()) {
        if (node.getType?.() === 'list' && node.getParent?.()?.getType?.() === 'root') {
          topStyle = node.getStyle?.() ?? ''
        }
      }
    })
    editor.update(
      () => {
        for (const node of (editor as any)._pendingEditorState._nodeMap.values()) {
          if (node.getType?.() === 'list') node.getWritable()
        }
      },
      { discrete: true },
    )
    return topStyle.includes(`--sn-list-levels: 1=${expectedMarker},2=${expectedMarker}`)
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, marker)
  expect(persisted, 'multilevel marker map persisted on the outer ListNode').toBe(true)
  await page.waitForFunction(allListsAreStamped, className)
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
  await buildTwoLevelList(page, twoBlocks)
}

test.describe('Super editor 2-level ordered-list numbering', () => {
  test('a single contiguous nested <ol>: native + custom markers all increment (a,b,c)', async ({ page }) => {
    await openEditorWithList(page, false)

    // (a) NATIVE upper-alpha (default .Lexical__ol2) — leave classes as rendered.
    const native = await fingerprintNestedMarkers(page)

    // (b) custom paren styles, persisted as a multilevel map on the outer ListNode.
    await buildTwoLevelList(page, false, 'lower-alpha-paren')
    await expectPersistedMarker(page, 'lower-alpha-paren')
    await expectNestedMarkerSequence(page, ['a) ', 'b) ', 'c) '])
    await buildTwoLevelList(page, false, 'decimal-paren')
    await expectPersistedMarker(page, 'decimal-paren')
    await expectNestedMarkerSequence(page, ['1) ', '2) ', '3) '])

    expect(native.length, 'three nested second-level items').toBe(3)
    expect(new Set(native).size, 'native upper-alpha increments (A,B,C)').toBe(3)
  })

  test('a paren second level split across nested <ol>s continues, not restarts (the A,A,A bug)', async ({ page }) => {
    await openEditorWithList(page, true)

    // Apply the paren style to the WHOLE list (top + every nested <ol>), the way a
    // user picks "a) b) c)" for the list. The top <ol> establishes independent
    // counters for each visual depth; both nested <ol>s increment level 2's
    // counter, while level-1 items cannot consume it. The exact result is a..f.
    await buildTwoLevelList(page, true, 'lower-alpha-paren')
    await expectPersistedMarker(page, 'lower-alpha-paren')
    await expectNestedMarkerSequence(page, ['a) ', 'b) ', 'c) ', 'd) ', 'e) ', 'f) '])
    await buildTwoLevelList(page, true, 'decimal-paren')
    await expectPersistedMarker(page, 'decimal-paren')
    await expectNestedMarkerSequence(page, ['1) ', '2) ', '3) ', '4) ', '5) ', '6) '])
    await buildTwoLevelList(page, true, 'lower-alpha-paren', true)
    await expectPersistedMarker(page, 'lower-alpha-paren')
    await expectNestedMarkerSequence(page, ['a) ', 'b) ', 'c) ', 'd) ', 'e) ', 'f) '])
  })
})
