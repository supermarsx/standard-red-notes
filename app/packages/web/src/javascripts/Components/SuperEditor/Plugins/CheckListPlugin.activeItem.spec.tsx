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
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CheckListPlugin } from './CheckListPlugin'
import { CHECKLIST_ACTIVE_ITEM_ATTR, CHECKLIST_DUE_REVEAL_ATTR } from '../Checklist/ChecklistDueControls'

jest.mock('../../ApplicationProvider', () => ({
  useApplication: () => ({
    platform: 'web',
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
