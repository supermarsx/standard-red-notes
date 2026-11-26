/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  LexicalEditor,
  UNDO_COMMAND,
  ParagraphNode,
  TextNode,
} from 'lexical'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import CollapsiblePlugin, { INSERT_COLLAPSIBLE_COMMAND } from './index'
import { CollapsibleContainerNode } from './CollapsibleContainerNode'
import { CollapsibleTitleNode } from './CollapsibleTitleNode'
import { CollapsibleContentNode } from './CollapsibleContentNode'
import InsertAccordionButton from '../ToolbarPlugin/InsertAccordionButton'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let editor: LexicalEditor, host: HTMLElement, root: Root
const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
function Capture() {
  const [value] = useLexicalComposerContext()
  useEffect(() => {
    editor = value
  }, [value])
  return <InsertAccordionButton editor={value} />
}
beforeEach(async () => {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: 'accordion',
          nodes: [CollapsibleContainerNode, CollapsibleTitleNode, CollapsibleContentNode],
          onError: (error) => {
            throw error
          },
          editorState: () =>
            $getRoot().append(
              ...['Before', 'First selected block', 'Second selected block', 'After'].map((text) =>
                $createParagraphNode().append($createTextNode(text).setStyle('color: red')),
              ),
            ),
        }}
      >
        <Capture />
        <CollapsiblePlugin />
        <HistoryPlugin />
        <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      </LexicalComposer>,
    ),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  if (originalRect) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect)
  } else {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  }
  if (originalRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', originalRects)
  } else {
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
  }
})
const details = () => host.querySelector<HTMLDetailsElement>('details')!
async function selectBlocks() {
  await act(async () =>
    editor.update(
      () => {
        const first = $getRoot().getChildAtIndex<ParagraphNode>(1)!
        const last = $getRoot().getChildAtIndex<ParagraphNode>(3)!
        const selection = first.selectStart()
        selection.focus.set(last.getFirstChild<TextNode>()!.getKey(), 0, 'text')
      },
      { discrete: true },
    ),
  )
}
it('names a zone from the Insert control, wraps only selected blocks, and keeps formatting and one-step undo', async () => {
  await selectBlocks()
  const before = editor.getEditorState().toJSON()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Insert accordion zone"]')!.click())
  const input = host.querySelector<HTMLInputElement>('[aria-label="Accordion zone title"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Project details')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(details().querySelector('summary')!.textContent).toBe('Project details')
  expect(details().querySelector('.Collapsible__content')!.textContent).toBe(
    'First selected blockSecond selected block',
  )
  expect(details().querySelectorAll('[style*="color: red"]').length).toBe(2)
  expect(
    editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .map((node) => node.getTextContent()),
    ),
  ).toEqual(['Before', expect.stringContaining('Project details'), 'After'])
  await act(async () => editor.dispatchCommand(UNDO_COMMAND, undefined))
  expect(editor.getEditorState().toJSON()).toEqual(before)
})
it('persists repeated open/close changes and reloads the resulting state', async () => {
  await act(async () => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, { title: 'Optional details' }))
  await act(async () => {
    details().open = false
    details().dispatchEvent(new Event('toggle'))
  })
  await act(async () => {
    details().open = true
    details().dispatchEvent(new Event('toggle'))
  })
  const saved = editor.getEditorState().toJSON()
  const zone = saved.root.children.find((node) => node.type === 'collapsible-container') as unknown as { open: boolean }
  expect(zone.open).toBe(true)
  await act(async () => editor.setEditorState(editor.parseEditorState(saved)))
  expect(details().open).toBe(true)
})

it('includes a partially selected last block when the selection ends at the start of a later styled text span', async () => {
  await act(async () =>
    editor.update(
      () => {
        const first = $getRoot().getChildAtIndex<ParagraphNode>(1)!
        const last = $getRoot().getChildAtIndex<ParagraphNode>(3)!
        last.getFirstChild<TextNode>()!.setTextContent('Selected prefix ')
        const tail = $createTextNode('remaining text').setStyle('font-weight: bold')
        last.append(tail)
        const selection = first.selectStart()
        selection.focus.set(tail.getKey(), 0, 'text')
      },
      { discrete: true },
    ),
  )
  await act(async () =>
    editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, { title: 'Whole blocks', wrapSelection: true }),
  )
  expect(details().querySelector('.Collapsible__content')!.textContent).toBe(
    'First selected blockSecond selected blockSelected prefix remaining text',
  )
  expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(2)
})
it('allows opening a saved zone in read mode without changing saved note content', async () => {
  await act(async () => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, { title: 'Read only', open: false }))
  await act(async () => editor.setEditable(false))
  const before = editor.getEditorState().toJSON()
  await act(async () => {
    details().open = true
    details().dispatchEvent(new Event('toggle'))
  })
  expect(details().open).toBe(true)
  expect(editor.getEditorState().toJSON()).toEqual(before)
  expect(editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, undefined)).toBe(false)
})
