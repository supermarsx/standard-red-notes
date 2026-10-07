/**
 * @jest-environment jsdom
 *
 * Two things are pinned here.
 *
 * 1. The "Tab-nesting a list item hangs the app" freeze.
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
 * makes the MutationObserver skip it and breaks the cycle.
 *
 * 2. The control is LEADING: it is drawn immediately before the block's own
 * text, in a rail reserved by `padding-inline-start`, and it is a real button
 * (focusable, Enter/Space, `aria-expanded`). jsdom cannot lay anything out, so
 * the geometry is asserted two ways that it CAN decide: the compiled stylesheet
 * is read for the rules that produce it, and the stylesheet's own selectors are
 * run against the DOM the plugin really renders. The pixel proof is the
 * headless-Chrome layout harness run against freshly compiled sass + Tailwind.
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

/**
 * Pull a rule straight out of the compiled stylesheet — BOTH halves — so the
 * tests below cannot drift from the CSS they assert about. A selector-matching
 * test on its own proves nothing about what the rule declares, which is exactly
 * how a mutation that emptied this rule survived its first guard.
 * Throws rather than silently matching nothing if the rule is gone.
 */
function ruleContaining(marker: string): { selector: string; body: string } {
  const rules = compiledCss.replace(/\/\*[\s\S]*?\*\//g, '').split('}')
  const rule = rules.find((candidate) => candidate.includes(marker))
  if (!rule) {
    throw new Error(`no rule in the compiled stylesheet contains ${marker}`)
  }
  return {
    selector: rule.slice(0, rule.indexOf('{')).trim().replace(/\s+/g, ' '),
    body: rule.slice(rule.indexOf('{') + 1).trim(),
  }
}

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

type MountedEditor = {
  container: HTMLDivElement
  editor: LexicalEditor
  teardown: () => void
}

function mountFoldableEditor(): MountedEditor {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const reactRoot = createRoot(container)
  let editor: LexicalEditor | undefined
  const onReady = (nextEditor: LexicalEditor) => {
    editor = nextEditor
  }

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
          contentEditable: createElement(ContentEditable, { className: 'ContentEditable__root' }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        createElement(SeedFoldableDocument, { onReady }),
        createElement(FoldablePlugin),
      ),
    )
  })

  if (!editor) {
    throw new Error('the editor never reported ready')
  }

  return {
    container,
    editor,
    teardown: () => {
      act(() => reactRoot.unmount())
      container.remove()
    },
  }
}

describe('FoldablePlugin fold-toggle (no-hang regression)', () => {
  it('marks the injected toggle as Lexical-unmanaged so the MutationObserver ignores it', () => {
    const toggle = createFoldToggle()
    expect(isDOMUnmanaged(toggle)).toBe(true)
  })

  it('builds a focusable button span with the expected hooks', () => {
    const toggle = createFoldToggle()
    expect(toggle.tagName).toBe('SPAN')
    expect(toggle.getAttribute('data-fold-toggle')).toBe('true')
    expect(toggle.getAttribute('role')).toBe('button')
    expect(toggle.getAttribute('contenteditable')).toBe('false')
    // A real control, reachable by assistive tech rather than mouse-only.
    expect(toggle.getAttribute('tabindex')).toBe('0')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('data-srn-print-exclude')).toBe('true')
    // The rail is LOGICAL and leading; the stylesheet keys its position on it.
    expect(toggle.getAttribute('data-fold-control-rail')).toBe('inline-start')
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
})

describe('Foldable stylesheet: the control leads its text', () => {
  it('positions the control at the logical leading edge and reclaims the right rail', () => {
    const toggleRule = compiledCss.slice(compiledCss.indexOf('.Lexical__foldToggle[data-fold-control-rail'))

    expect(toggleRule).toMatch(/position:\s*absolute;/)
    expect(toggleRule).toMatch(/inset-inline-start:\s*0;/)
    // The explicit `auto` end is what stops the old right-edge pin from
    // surviving in any cascade, and it is what makes RTL mirror for free.
    expect(toggleRule).toMatch(/inset-inline-end:\s*auto;/)

    // No physical placement anywhere: not the reclaimed right rail, not the
    // editor's left gutter (DraggableBlockPlugin's portal owns that), and no
    // negative inset reaching into it.
    expect(compiledCss).not.toMatch(/\.Lexical__foldToggle[^{]*\{[^}]*(^|[^-])right:/s)
    expect(compiledCss).not.toMatch(/\.Lexical__foldToggle[^{]*\{[^}]*(^|[^-])left:/s)
    expect(compiledCss).not.toMatch(/inset-inline-start:\s*-/)
    expect(compiledCss).not.toMatch(/padding-right:/)
    expect(compiledCss).not.toContain('.draggable-block-menu')
  })

  it('reserves one shared rail that every target size moves together', () => {
    expect(compiledCss).toMatch(
      /--sn-fold-rail:\s*calc\(var\(--sn-fold-control-size\)\s*\+\s*var\(--sn-fold-control-gap\)\)/,
    )
    // gap-1 from the app's spacing scale, not a one-off pixel value.
    expect(compiledCss).toMatch(/--sn-fold-control-gap:\s*0\.25rem/)
    expect(compiledCss).not.toMatch(/--sn-fold-control-gap:\s*\d+px/)
    expect(compiledCss).toMatch(/--sn-fold-control-size:\s*1\.5rem/)

    // Both responsive modes resize the shared variable AT THE ROOT, so the
    // reservations on non-foldable blocks grow with the target rather than
    // drifting away from it.
    expect(compiledCss).toMatch(
      /@media screen and \(max-width: 450px\)\s*\{\s*:root\s*\{[^}]*--sn-fold-control-size:\s*1\.75rem/,
    )
    expect(compiledCss).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{[^}]*--sn-fold-control-size:\s*2rem/)
    expect(compiledCss).toMatch(/@media print[\s\S]*\.Lexical__foldToggle[^{]*\{[^}]*display:\s*none !important/s)
  })

  it('keeps the hit area finger-sized without making the line taller', () => {
    const toggleRule = compiledCss.slice(compiledCss.indexOf('.Lexical__foldToggle[data-fold-control-rail'))

    expect(toggleRule).toMatch(/width:\s*var\(--sn-fold-control-size\);/)
    // The square is the FLOOR and is declared first, so a browser without `lh`
    // still gets a 24px target; the `max()` then grows the box to the host's
    // first line so the chevron sits on the text at every heading size.
    expect(toggleRule).toMatch(
      /height:\s*var\(--sn-fold-control-size\);\s*height:\s*max\(var\(--sn-fold-control-size\),\s*1lh\);/,
    )
    // Out of flow, so that taller box is padded INSIDE the line.
    expect(toggleRule).toMatch(/position:\s*absolute;/)
    expect(toggleRule).toMatch(/align-items:\s*center;/)
  })

  it('reveals the control with opacity alone, so nothing reflows on hover or focus', () => {
    const revealRule = compiledCss.slice(
      compiledCss.indexOf('.Lexical__foldable:hover > .Lexical__foldToggle'),
      compiledCss.indexOf('.Lexical__foldCollapsed > .Lexical__foldToggle::before'),
    )

    expect(revealRule).toMatch(/\.Lexical__foldable:hover > \.Lexical__foldToggle/)
    expect(revealRule).toMatch(/\.Lexical__foldable:focus-within > \.Lexical__foldToggle/)
    expect(revealRule).toMatch(/\.Lexical__foldCollapsed > \.Lexical__foldToggle/)
    expect(revealRule).toMatch(/\.Lexical__foldToggle:focus-visible/)
    expect(revealRule).toMatch(/opacity:\s*1;/)
    // Never `display` or `visibility`: the reveal must not change any box.
    expect(revealRule).not.toMatch(/display:/)
    expect(revealRule).not.toMatch(/visibility:/)
    // ...and it is a real control, so it gets a real ring.
    expect(compiledCss).toMatch(/\.Lexical__foldToggle:focus-visible\s*\{[^}]*outline:\s*2px solid/s)
  })

  it('still mirrors the collapsed chevron for RTL, the one genuinely physical bit', () => {
    expect(compiledCss).toMatch(/\.Lexical__foldCollapsed > \.Lexical__foldToggle::before\s*\{[^}]*rotate\(-90deg\)/s)

    const mirrored = ruleContaining('rotate(90deg)').selector
    // `:dir()` covers direction inherited from a parent editor/list; the class
    // and attribute forms cover Lexical's own explicit direction markers.
    expect(mirrored).toContain('.Lexical__foldCollapsed:dir(rtl) > .Lexical__foldToggle::before')
    expect(mirrored).toContain('.Lexical__foldCollapsed.Lexical__rtl > .Lexical__foldToggle::before')
    expect(mirrored).toContain('.Lexical__foldCollapsed[dir=rtl] > .Lexical__foldToggle::before')
  })

  it('gives a collapsed list fold a row of its own instead of painting over the next one', () => {
    // Collapsing a list fold hides the wrapper's only child, so without this
    // the wrapper is a zero-height row and its (now permanently visible)
    // control lands on the following item's bullet or checkbox.
    const collapsed = ruleContaining('min-height')
    expect(collapsed.selector).toContain('.Lexical__foldCollapsed.Lexical__foldable--list')
    expect(collapsed.selector).toContain('.Lexical__foldCollapsed.Lexical__foldable--checklist')
    expect(collapsed.body).toMatch(/^min-height:\s*var\(--sn-fold-control-size\);$/)
    // A collapsed heading still renders its own text, so it must not be padded.
    expect(collapsed.selector).not.toContain('--heading')
  })

  it('keeps a foldable checklist item that draws its own checkbox out from under the control', () => {
    // Lexical's editing path cannot build `li > [text, list]`, but an import
    // can; without this the leading control would cover the checkbox.
    expect(compiledCss).toMatch(
      /\.Lexical__foldable--checklist:not\(\.Lexical__nestedListItem\)\s*\{\s*padding-inline-start:\s*calc\(var\(--checkbox-size\)/s,
    )
    expect(compiledCss).toMatch(
      /:not\(\.Lexical__nestedListItem\)::before[^{]*\{\s*inset-inline-start:\s*var\(--sn-fold-rail\);\s*inset-inline-end:\s*auto;/s,
    )
  })
})

describe('Foldable stylesheet: the reserved slot keeps headings aligned', () => {
  const HEADING_RESERVATION = '.ContentEditable__root:has('

  it('reserves the rail on EVERY top-level heading of a fold-enabled surface, foldable or not', () => {
    const { selector, body } = ruleContaining(HEADING_RESERVATION)

    // What the rule DECLARES, not merely that a rule with this selector exists.
    expect(body).toMatch(/^padding-inline-start:\s*var\(--sn-fold-rail\);$/)

    const surface = document.createElement('div')
    surface.className = 'ContentEditable__root'
    surface.innerHTML = [
      '<h2 class="Lexical__h2 Lexical__foldable Lexical__foldable--heading"><span>With a section under it</span></h2>',
      '<p class="Lexical__paragraph"><span>Body</span></p>',
      '<h2 class="Lexical__h2"><span>With nothing under it</span></h2>',
      '<blockquote class="Lexical__quote"><h2 class="Lexical__h2"><span>Inside a quote</span></h2></blockquote>',
    ].join('')
    document.body.appendChild(surface)

    try {
      const [foldable, plain] = Array.from(surface.querySelectorAll(':scope > h2'))
      const nested = surface.querySelector('blockquote h2') as HTMLElement

      // Both top-level headings of the same level reserve the same slot, so
      // their text starts at the same x whether or not they fold anything.
      expect(foldable.matches(selector)).toBe(true)
      expect(plain.matches(selector)).toBe(true)
      // A heading inside another container keeps that container's text column.
      expect(nested.matches(selector)).toBe(false)
    } finally {
      surface.remove()
    }
  })

  it('reserves the rail on the foldable host itself, so the control never sits on its own text', () => {
    // Belt and braces for any surface the `:has()` rule above does not reach:
    // the block that OWNS a control always reserves that control's slot.
    for (const kind of ['heading', 'list']) {
      expect(compiledCss).toMatch(
        new RegExp(
          `\\.Lexical__foldable\\.Lexical__foldable--${kind}[^{]*\\{\\s*padding-inline-start:\\s*var\\(--sn-fold-rail\\);`,
          's',
        ),
      )
    }
    // A checklist wrapper's nested list already carries a flat 1rem indent, so
    // only the remainder is reserved — but it is still the LEADING side.
    expect(compiledCss).toMatch(
      /\.Lexical__foldable\.Lexical__foldable--checklist[^{]*\{\s*padding-inline-start:\s*max\(0px, var\(--sn-fold-rail\) - 1rem\);/s,
    )
    expect(compiledCss).not.toMatch(/padding-inline-end:/)
  })

  it('reserves nothing on a surface that never mounts the plugin, such as the share viewer', () => {
    const { selector } = ruleContaining(HEADING_RESERVATION)
    const surface = document.createElement('div')
    surface.className = 'ContentEditable__root blocks-editor'
    surface.innerHTML =
      '<h1 class="Lexical__h1"><span>Shared note</span></h1><h2 class="Lexical__h2"><span>Part</span></h2>'
    document.body.appendChild(surface)

    try {
      for (const heading of Array.from(surface.children)) {
        expect(heading.matches(selector)).toBe(false)
      }
    } finally {
      surface.remove()
    }
  })

  it('reserves the rail the real plugin output actually needs', () => {
    const { selector, body } = ruleContaining(HEADING_RESERVATION)
    expect(body).toContain('padding-inline-start: var(--sn-fold-rail)')
    const mounted = mountFoldableEditor()

    try {
      const root = mounted.container.querySelector('.ContentEditable__root') as HTMLElement
      const headings = Array.from(root.querySelectorAll(':scope > h1'))

      expect(headings).toHaveLength(2)
      for (const heading of headings) {
        expect(heading.matches(selector)).toBe(true)
        expect(heading.matches('.Lexical__foldable--heading')).toBe(true)
      }
    } finally {
      mounted.teardown()
    }
  })
})

describe('FoldablePlugin behaviour on a real composer', () => {
  it('renders, collapses, and re-expands real heading/checklist DOM without leaving folded descendants behind', () => {
    const mounted = mountFoldableEditor()

    try {
      const { container } = mounted
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
      mounted.teardown()
    }
  })

  it('keeps the control last in the DOM even though the stylesheet draws it first', () => {
    const mounted = mountFoldableEditor()

    try {
      const firstHeading = mounted.container.querySelector('h1') as HTMLElement
      const toggle = firstHeading.querySelector<HTMLElement>('[data-fold-toggle]')

      // Leading is a PAINT decision (absolute positioning in a reserved rail).
      // Moving it first in the DOM would seat the caret around a non-editable
      // child on Home / click-at-column-zero.
      expect(firstHeading.lastElementChild).toBe(toggle)
      expect(firstHeading.firstElementChild).not.toBe(toggle)
    } finally {
      mounted.teardown()
    }
  })

  it('activates from the keyboard and reports its state, without letting the key reach Lexical', () => {
    const mounted = mountFoldableEditor()

    try {
      const { container } = mounted
      const headingToggle = container.querySelector<HTMLElement>('[data-fold-kind="heading"]') as HTMLElement
      const body = Array.from(container.querySelectorAll('p')).find((node) => node.textContent === 'Section body')

      const press = (key: string) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        act(() => {
          headingToggle.dispatchEvent(event)
        })
        return event
      }

      const enter = press('Enter')
      expect(enter.defaultPrevented).toBe(true)
      expect(body?.classList.contains('Lexical__folded')).toBe(true)
      expect(headingToggle.getAttribute('aria-expanded')).toBe('false')

      const space = press(' ')
      expect(space.defaultPrevented).toBe(true)
      expect(body?.classList.contains('Lexical__folded')).toBe(false)
      expect(headingToggle.getAttribute('aria-expanded')).toBe('true')

      // Every other key is Lexical's: swallowing them all would stop typing.
      const letter = press('a')
      expect(letter.defaultPrevented).toBe(false)
      expect(body?.classList.contains('Lexical__folded')).toBe(false)
    } finally {
      mounted.teardown()
    }
  })

  it('swallows its own mousedown so clicking it cannot pull focus out of the editable', () => {
    const mounted = mountFoldableEditor()

    try {
      const { container } = mounted
      const headingToggle = container.querySelector<HTMLElement>('[data-fold-kind="heading"]') as HTMLElement
      const heading = headingToggle.parentElement as HTMLElement

      const onToggle = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      act(() => {
        headingToggle.dispatchEvent(onToggle)
      })
      expect(onToggle.defaultPrevented).toBe(true)

      // ...and only its own: a mousedown on the text must still place the caret.
      const onText = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      act(() => {
        ;(heading.firstElementChild as HTMLElement).dispatchEvent(onText)
      })
      expect(onText.defaultPrevented).toBe(false)
    } finally {
      mounted.teardown()
    }
  })
})
