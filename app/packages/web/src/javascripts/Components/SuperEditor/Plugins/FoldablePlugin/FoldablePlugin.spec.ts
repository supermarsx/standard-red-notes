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
import * as path from 'path'
import * as sass from 'sass'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text'
import { $createParagraphNode, $createTextNode, $getRoot, isDOMUnmanaged, LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import FoldablePlugin, { createFoldToggle, syncFoldControl } from './FoldablePlugin'

const FOLDABLE_SCSS = path.resolve(__dirname, 'Foldable.scss')

let compiledCss = ''

beforeAll(() => {
  compiledCss = sass.compile(FOLDABLE_SCSS, { style: 'expanded' }).css
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function SeedFoldableDocument({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()

        const heading = $createHeadingNode('h1').append($createTextNode('Folded section'))
        const body = $createParagraphNode().append($createTextNode('Section body'))
        const nextHeading = $createHeadingNode('h1').append($createTextNode('Next section'))

        const checklist = $createListNode('check')
        const task = $createListItemNode(false).append($createTextNode('Parent task'))
        const nestedChecklist = $createListNode('check').append(
          $createListItemNode(false).append($createTextNode('Nested task')),
        )
        const nestedWrapper = $createListItemNode().append(nestedChecklist)
        checklist.append(task, nestedWrapper)

        root.append(heading, body, nextHeading, checklist)
      },
      { discrete: true },
    )
    onReady(editor)
  }, [editor, onReady])

  return null
}

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
    expect(toggle.getAttribute('tabindex')).toBe('-1')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('data-srn-print-exclude')).toBe('true')
    expect(toggle.getAttribute('data-fold-control-rail')).toBe('opposite-drag-handle')
    expect(toggle.getAttribute('data-fold-kind')).toBe('heading')
    expect(toggle.className).toContain('Lexical__foldToggle')
    expect(toggle.className).toContain('Lexical__foldToggle--heading')
  })

  it('appends a checklist disclosure without rearranging Lexical-managed children', () => {
    const item = document.createElement('li')
    const text = document.createElement('span')
    const nestedList = document.createElement('ul')
    text.textContent = 'Parent task'
    nestedList.innerHTML = '<li>Nested task</li>'
    item.append(text, nestedList)

    const toggle = syncFoldControl(item, 'task-key', 'checklist', false)

    expect(item.children[0]).toBe(text)
    expect(item.children[1]).toBe(nestedList)
    expect(item.lastElementChild).toBe(toggle)
    expect(item.classList.contains('Lexical__foldable--checklist')).toBe(true)
    expect(item.getAttribute('data-fold-key')).toBe('task-key')
    expect(toggle?.getAttribute('data-fold-kind')).toBe('checklist')
    expect(toggle?.classList.contains('Lexical__foldToggle--checklist')).toBe(true)
    expect(isDOMUnmanaged(toggle as HTMLElement)).toBe(true)
  })

  it('updates one control in place across kind/collapse changes and removes only that unmanaged child', () => {
    const item = document.createElement('li')
    const managedText = document.createTextNode('Managed text')
    item.appendChild(managedText)

    const checklistToggle = syncFoldControl(item, 'same-key', 'checklist', false)
    const listToggle = syncFoldControl(item, 'same-key', 'list', true)

    expect(listToggle).toBe(checklistToggle)
    expect(item.classList.contains('Lexical__foldable--checklist')).toBe(false)
    expect(item.classList.contains('Lexical__foldable--list')).toBe(true)
    expect(listToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(listToggle?.getAttribute('data-fold-kind')).toBe('list')
    expect(item.childNodes[0]).toBe(managedText)

    expect(syncFoldControl(item, 'same-key', null, false)).toBeNull()
    expect(item.childNodes).toHaveLength(1)
    expect(item.childNodes[0]).toBe(managedText)
    expect(item.hasAttribute('data-fold-key')).toBe(false)
    expect(item.className).toBe('')
  })

  it('keeps fold and reorder controls in separate semantic/layout rails across responsive and RTL modes', () => {
    // The reorder handle is portal-positioned at the editor's physical left.
    // This stylesheet must therefore reserve an in-block physical-right rail,
    // not reintroduce a negative left-gutter position for fold controls.
    expect(compiledCss).toMatch(
      /\.Lexical__foldToggle\[data-fold-control-rail=opposite-drag-handle\]\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;/s,
    )
    expect(compiledCss).not.toMatch(/\.Lexical__foldToggle[^\{]*\{[^}]*left:\s*-/s)
    expect(compiledCss).not.toContain('.draggable-block-menu')
    // Fold chrome must not claim the host's ::before/::after pseudo-elements;
    // checklist checkbox and checkmark rendering continue to own those slots.
    expect(compiledCss).not.toContain('.Lexical__foldCollapsed.Lexical__foldable::after')

    // Kind markers reserve the action rail. RTL checklists additionally offset
    // the disclosure from the independently clickable right-side checkbox.
    expect(compiledCss).toMatch(/\.Lexical__foldable\.Lexical__foldable--checklist[^\{]*\{[^}]*padding-right:/s)
    expect(compiledCss).toMatch(
      /\.Lexical__foldable\.Lexical__foldable--checklist:dir\(rtl\)[^\{]*\{[^}]*--checkbox-size[^}]*--sn-fold-control-size/s,
    )
    expect(compiledCss).toMatch(/> \.Lexical__foldToggle\s*\{[^}]*right:\s*calc\(var\(--checkbox-size\)/s)

    // Both narrow and coarse-pointer modes resize the shared rail variable, so
    // target growth and content reservation cannot drift apart.
    expect(compiledCss).toMatch(/@media screen and \(max-width: 450px\)[\s\S]*--sn-fold-control-size:\s*1\.75rem/)
    expect(compiledCss).toMatch(/@media \(pointer: coarse\)[\s\S]*--sn-fold-control-size:\s*2rem/)
    expect(compiledCss).toMatch(/@media print[\s\S]*\.Lexical__foldToggle[^{]*\{[^}]*display:\s*none !important/s)
  })

  it('renders, collapses, and re-expands real heading/checklist DOM without leaving folded descendants behind', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const reactRoot = createRoot(container)
    let editor: LexicalEditor | undefined
    const onReady = (nextEditor: LexicalEditor) => {
      editor = nextEditor
    }

    try {
      act(() => {
        reactRoot.render(
          createElement(
            LexicalComposer,
            {
              initialConfig: {
                namespace: 'FoldablePluginSpec',
                nodes: [HeadingNode, ListNode, ListItemNode],
                onError: (error: Error) => {
                  throw error
                },
                theme: {
                  heading: { h1: 'Lexical__h1' },
                  list: {
                    checklist: 'Lexical__checkList',
                    listitem: 'Lexical__listItem',
                    listitemChecked: 'Lexical__listItemChecked',
                    listitemUnchecked: 'Lexical__listItemUnchecked',
                    nested: { listitem: 'Lexical__nestedListItem' },
                  },
                },
              },
            },
            createElement(RichTextPlugin, {
              contentEditable: createElement(ContentEditable, {}),
              placeholder: null,
              ErrorBoundary: LexicalErrorBoundary,
            }),
            createElement(SeedFoldableDocument, { onReady }),
            createElement(FoldablePlugin),
          ),
        )
      })

      expect(editor).toBeDefined()
      const firstHeading = container.querySelector('h1') as HTMLElement
      const headingToggle = firstHeading.querySelector<HTMLElement>('[data-fold-toggle]')
      const body = Array.from(container.querySelectorAll('p')).find((node) => node.textContent === 'Section body')
      const checklistToggle = container.querySelector<HTMLElement>('[data-fold-kind="checklist"]')

      expect(headingToggle).not.toBeNull()
      expect(body).toBeDefined()
      expect(checklistToggle).not.toBeNull()
      expect(checklistToggle?.parentElement?.classList.contains('Lexical__foldable--checklist')).toBe(true)
      expect(checklistToggle?.parentElement?.classList.contains('Lexical__nestedListItem')).toBe(true)

      act(() => headingToggle?.click())
      expect(body?.classList.contains('Lexical__folded')).toBe(true)
      expect(headingToggle?.getAttribute('aria-expanded')).toBe('false')

      act(() => headingToggle?.click())
      expect(body?.classList.contains('Lexical__folded')).toBe(false)
      expect(headingToggle?.getAttribute('aria-expanded')).toBe('true')
    } finally {
      act(() => reactRoot.unmount())
      container.remove()
    }
  })
})
