/** @jest-environment jsdom */

/**
 * End-to-end proof that the per-item schedule affordance actually follows the
 * CARET through the real CheckListPlugin — not just that the DOM helpers behave
 * when called directly (ChecklistDueControls.reveal.spec.ts covers that).
 *
 * This is the half that would silently rot: the helpers could stay perfect while
 * nothing ever calls them, and the control would then appear on every row (or
 * on none) with every unit test still green. So this mounts the plugin, moves
 * the Lexical selection between rows, and asserts the marker moves with it.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, type LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CheckListPlugin } from './CheckListPlugin'
import { $setChecklistFlags } from '../Lexical/Nodes/ChecklistItemNode'
import { CHECKLIST_ACTIVE_ITEM_ATTR, CHECKLIST_DUE_REVEAL_ATTR } from '../Checklist/ChecklistDueControls'
import {
  $getChecklistPersonalTicks,
  $setChecklistPersonalTick,
  $setChecklistPerPerson,
} from '../Checklist/checklistPersonalTicks'

jest.mock('../../ApplicationProvider', () => ({
  useApplication: () => ({
    platform: 'web',
    sessions: { getUser: () => ({ uuid: 'alice' }) },
    keyboardService: {
      activeModifiers: new Set(),
      registerExternalKeyboardShortcutHelpItem: () => () => undefined,
    },
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW_LABELS = ['first task', 'second task', 'third task']

let editor: LexicalEditor | undefined

function CaptureAndSeed() {
  const [composerEditor] = useLexicalComposerContext()

  useEffect(() => {
    editor = composerEditor
    composerEditor.update(
      () => {
        const list = $createListNode('check')
        for (const label of ROW_LABELS) {
          list.append($createListItemNode(false).append($createTextNode(label)))
        }
        const paragraph = $createParagraphNode().append($createTextNode('after the list'))
        $getRoot().clear().append(list, paragraph)
      },
      { discrete: true },
    )
  }, [composerEditor])

  return null
}

function Harness() {
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'checklist-active-item',
        nodes: [ListNode, ListItemNode],
        onError: (error: Error) => {
          throw error
        },
      },
    },
    createElement(RichTextPlugin, {
      contentEditable: createElement(ContentEditable, { 'aria-label': 'editor' }),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
    createElement(CaptureAndSeed),
    createElement(CheckListPlugin),
  )
}

/** Put the caret in the row whose text is `label`, the way arrowing there would. */
const placeCaretInRow = (label: string) => {
  act(() => {
    ;(editor as LexicalEditor).update(
      () => {
        const list = $getRoot().getFirstChild<ListNode>() as ListNode
        const row = list.getChildren().find((child) => child.getTextContent() === label) as ListItemNode
        row.getFirstChild()!.selectEnd()
      },
      { discrete: true },
    )
  })
}

const placeCaretInParagraph = () => {
  act(() => {
    ;(editor as LexicalEditor).update(
      () => {
        ;($getRoot().getLastChild() as ListNode).getFirstChild()!.selectEnd()
      },
      { discrete: true },
    )
  })
}

describe('the schedule affordance follows the caret through the real plugin', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    editor = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('li'))

  /** The row's own task text, with the due shell's control text stripped off. */
  const taskText = (row: HTMLElement) => {
    const shellText = row.querySelector('[data-checklist-due-shell]')?.textContent ?? ''
    return (row.textContent ?? '').replace(shellText, '').trim()
  }

  const activeLabels = () =>
    rows()
      .filter((row) => row.getAttribute(CHECKLIST_ACTIVE_ITEM_ATTR) === 'true')
      .map(taskText)

  const revealedCount = () => container.querySelectorAll(`[${CHECKLIST_DUE_REVEAL_ATTR}='active']`).length

  it('keeps priority, pin and multi-tick indicators visible on their own item and updates them without editing task text', () => {
    act(() =>
      editor!.update(
        () => {
          const list = $getRoot().getFirstChild<ListNode>()!
          const first = list.getFirstChild<ListItemNode>()!
          const second = list.getChildren()[1] as ListItemNode
          $setChecklistFlags(first, { priority: 'high', pinned: true })
          $setChecklistFlags(second, { priority: 'low' })
          $setChecklistPerPerson(first, true)
          $setChecklistPersonalTick(first, 'bob', true)
        },
        { discrete: true },
      ),
    )
    expect(rows()[0].querySelector('[data-checklist-indicators]')?.textContent).toBe('Pinned⚑ High☑ 1')
    expect(rows()[1].querySelector('[data-checklist-indicators]')?.textContent).toBe('⚑ Low')
    expect(rows()[2].querySelector('[data-checklist-indicators]')).toBeNull()
    placeCaretInParagraph()
    act(() => editor!.setEditable(false))
    expect(rows()[0].querySelector('[data-checklist-indicators]')?.getAttribute('aria-label')).toContain(
      'Per-person completion: 1 ticked',
    )
    act(() =>
      editor!.update(
        () => {
          const first = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
          $setChecklistFlags(first, { priority: 'normal', pinned: false })
          $setChecklistPerPerson(first, false)
          expect(first.getTextContent()).toBe('first task')
        },
        { discrete: true },
      ),
    )
    expect(rows()[0].querySelector('[data-checklist-indicators]')).toBeNull()
  })

  it('projects and toggles your own multi-tick checkbox without clearing another person or changing shared completion', async () => {
    act(() =>
      editor!.update(
        () => {
          const row = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
          $setChecklistPerPerson(row, true)
          $setChecklistPersonalTick(row, 'bob', true)
        },
        { discrete: true },
      ),
    )
    const row = rows()[0]
    expect(row.getAttribute('aria-checked')).toBe('false')
    row.style.lineHeight = '20px'
    jest.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 300, top: 0, bottom: 20 } as DOMRect)
    const original = window.getComputedStyle.bind(window)
    const styles = jest
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element: Element, pseudo?: string | null) => {
        if (pseudo) return { width: '24px' } as CSSStyleDeclaration
        const style = original(element)
        const getPropertyValue = style.getPropertyValue.bind(style)
        // jsdom does not implement CSS zoom's browser default of 1.
        style.getPropertyValue = (property) => (property === 'zoom' ? '1' : getPropertyValue(property))
        return style
      })
    try {
      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      })
      editor!.getEditorState().read(() => {
        const task = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        expect($getChecklistPersonalTicks(task)).toEqual(['alice', 'bob'])
        expect(task.getChecked()).toBe(false)
      })
      expect(row.getAttribute('aria-checked')).toBe('true')
      expect(row.classList.contains('Lexical__listItemChecked')).toBe(true)
      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      })
      expect(row.getAttribute('aria-checked')).toBe('false')
      editor!
        .getEditorState()
        .read(() =>
          expect(
            $getChecklistPersonalTicks($getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!),
          ).toEqual(['bob']),
        )
    } finally {
      styles.mockRestore()
    }
  })

  it('triple-click selects the item text without the schedule controls or following row', () => {
    const row = rows()[1]
    const text = row.querySelector('[data-lexical-text]')!
    act(() => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }))
    })
    editor!.getEditorState().read(() => expect($getSelection()?.getTextContent()).toBe('second task'))
    expect(row.getAttribute('aria-checked')).toBe('false')
  })

  it('triple-click spans formatted text and wrapped lines while excluding nested checklist items', () => {
    act(() =>
      editor!.update(
        () => {
          const row = $getRoot().getFirstChild<ListNode>()!.getChildren<ListItemNode>()[1]
          row
            .clear()
            .append(
              $createTextNode('first '),
              $createTextNode('formatted wrapped text').toggleFormat('italic'),
              $createListNode('check').append($createListItemNode(false).append($createTextNode('nested task'))),
            )
        },
        { discrete: true },
      ),
    )
    const text = rows()[1].querySelector('em')!
    act(() => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }))
    })
    editor!.getEditorState().read(() => expect($getSelection()?.getTextContent()).toBe('first formatted wrapped text'))
  })

  it('renders a due shell on every row but reveals at most one', () => {
    expect(rows()).toHaveLength(ROW_LABELS.length)
    expect(container.querySelectorAll('[data-checklist-due-shell]')).toHaveLength(ROW_LABELS.length)
    expect(revealedCount()).toBeLessThanOrEqual(1)
  })

  it('marks the row holding the caret, and only that row', () => {
    placeCaretInRow('second task')

    expect(activeLabels()).toEqual(['second task'])
    expect(revealedCount()).toBe(1)
    const active = rows().find((row) => row.getAttribute(CHECKLIST_ACTIVE_ITEM_ATTR) === 'true')!
    expect(active.querySelector('[data-checklist-due-shell]')!.getAttribute(CHECKLIST_DUE_REVEAL_ATTR)).toBe('active')
  })

  it('moves the marker as the caret moves between rows', () => {
    placeCaretInRow('first task')
    expect(activeLabels()).toEqual(['first task'])

    placeCaretInRow('third task')
    expect(activeLabels()).toEqual(['third task'])
    expect(revealedCount()).toBe(1)
  })

  it('reveals nothing once the caret leaves the checklist', () => {
    placeCaretInRow('first task')
    placeCaretInParagraph()

    expect(activeLabels()).toEqual([])
    expect(revealedCount()).toBe(0)
  })

  it('exposes the trigger to the keyboard only on the active row', () => {
    placeCaretInRow('second task')

    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-checklist-due-action="edit-schedule"]'),
    )
    expect(triggers).toHaveLength(ROW_LABELS.length)

    const reachable = triggers.filter(
      (button) => button.getAttribute('aria-hidden') !== 'true' && button.getAttribute('tabindex') !== '-1',
    )
    expect(reachable).toHaveLength(1)
    expect(taskText(reachable[0].closest('li') as HTMLElement)).toBe('second task')
  })
})
