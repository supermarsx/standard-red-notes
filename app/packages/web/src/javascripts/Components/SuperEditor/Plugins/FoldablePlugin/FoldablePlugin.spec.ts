/**
 * @jest-environment jsdom
 *
 * Regression guard for the "Tab-nesting a list item hangs the app" freeze.
 *
 * ROOT CAUSE: FoldablePlugin injects a fold-toggle <span> into Lexical-owned
 * list-item / heading elements. Lexical's DOM MutationObserver (which watches
 * `childList`/`subtree`) treats any foreign child as a stray node, synchronously
 * `removeChild`s it and reverts the selection; that revert schedules another
 * editor update, which re-runs FoldablePlugin's update listener, which
 * re-inserts the toggle, which the observer removes again — an unbounded
 * insert/observe/remove/update loop that froze the main thread the instant a
 * list item became foldable (e.g. Tab-nesting a second list item).
 *
 * The full loop is NOT reproducible headless: jsdom + the Lexical test path do
 * not drive the same DOM MutationObserver revert cycle, which is exactly why the
 * earlier "fix" (and unit tests) passed while the app still hung. This test
 * instead pins the load-bearing invariant of the real fix: every injected
 * fold-toggle MUST be marked Lexical-UNMANAGED (`setDOMUnmanaged`), which is what
 * makes the MutationObserver skip it and breaks the cycle. If a future change
 * drops that flag, this test fails — and the e2e `super-tab-no-hang.spec.ts`
 * remains the end-to-end proof in a real browser.
 */
import { isDOMUnmanaged } from 'lexical'

import { createFoldToggle } from './FoldablePlugin'

describe('FoldablePlugin fold-toggle (no-hang regression)', () => {
  it('marks the injected toggle as Lexical-unmanaged so the MutationObserver ignores it', () => {
    const toggle = createFoldToggle()
    expect(isDOMUnmanaged(toggle)).toBe(true)
  })

  it('builds a clickable toggle span with the expected hooks', () => {
    const toggle = createFoldToggle()
    expect(toggle.tagName).toBe('SPAN')
    expect(toggle.getAttribute('data-fold-toggle')).toBe('true')
    expect(toggle.getAttribute('role')).toBe('button')
    expect(toggle.getAttribute('contenteditable')).toBe('false')
    expect(toggle.className).toContain('Lexical__foldToggle')
  })
})
