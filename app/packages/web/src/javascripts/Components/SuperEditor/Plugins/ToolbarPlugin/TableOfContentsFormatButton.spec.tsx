/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createNodeSelection,
  $getRoot,
  $getSelection,
  $setSelection,
  LexicalEditor,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import TableOfContentsFormatButton from './TableOfContentsFormatButton'
import { $createTableOfContentsNode, TableOfContentsNode } from '../../Lexical/Nodes/TableOfContentsNode'
import type { ToolbarButtonProps } from './ToolbarButton'

let mockEditor: LexicalEditor
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => {
    return open ? <div role="dialog">{children}</div> : null
  },
}))
jest.mock('./ToolbarButton', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(function Button(
      { name, children, onSelect, disabled },
      ref,
    ) {
      return (
        <button ref={ref} aria-label={String(name)} disabled={disabled} onClick={onSelect}>
          {children}
        </button>
      )
    }),
  }
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let element: HTMLElement
let root: Root
beforeEach(() => {
  mockEditor = createHeadlessEditor({
    namespace: 'toc-controls',
    nodes: [TableOfContentsNode],
    onError(error) {
      throw error
    },
  })
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
})
async function mount(count: number, selectFirst = false) {
  mockEditor.update(
    () => {
      const nodes = Array.from({ length: count }, () => $createTableOfContentsNode())
      $getRoot().append(...nodes)
      if (selectFirst && nodes[0]) {
        const selection = $createNodeSelection()
        selection.add(nodes[0].getKey())
        $setSelection(selection)
      }
    },
    { discrete: true },
  )
  await act(async () => root.render(<TableOfContentsFormatButton />))
  return element.querySelector<HTMLButtonElement>('button')!
}
function formats() {
  return mockEditor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => (node as TableOfContentsNode).exportJSON().format),
  )
}
async function changeSelect(label: string, value: string) {
  const select = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('disables formatting when the document has no index', async () => {
  const button = await mount(0)
  expect(button.disabled).toBe(true)
  await act(async () => button.click())
  expect(element.querySelector('[role="dialog"]')).toBeNull()
})

it('persists heading depth, numbering, and title changes through the actual controls', async () => {
  const button = await mount(1)
  await act(async () => button.click())
  await changeSelect('Table of contents heading depth', '3')
  const checkboxes = element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  await act(async () => checkboxes[0].click())
  await act(async () => checkboxes[1].click())
  expect(formats()).toEqual([{ maxLevel: 3, numbered: true, showTitle: false }])
})

it('does not reclaim editor focus while a user changes a formatting control', async () => {
  const button = await mount(1)
  await act(async () => button.click())
  const tags: Set<string>[] = []
  const stop = mockEditor.registerUpdateListener((update) => {
    tags.push(update.tags)
  })
  await changeSelect('Table of contents heading depth', '2')
  expect(tags.some((entry) => entry.has(SKIP_DOM_SELECTION_TAG))).toBe(true)
  stop()
})

it('refuses mutations if the editor becomes read-only while the menu is open', async () => {
  const button = await mount(1)
  await act(async () => button.click())
  mockEditor.setEditable(false)
  await changeSelect('Table of contents heading depth', '2')
  await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(formats()).toEqual([{ maxLevel: 6, numbered: false, showTitle: true }])
})

it('keeps the explicitly chosen index as the formatting target despite a different node selection', async () => {
  const button = await mount(2, true)
  await act(async () => button.click())
  const targetSelect = element.querySelector<HTMLSelectElement>('select[aria-label="Table of contents to format"]')!
  const secondKey = targetSelect.options[1].value
  await changeSelect('Table of contents to format', secondKey)
  await changeSelect('Table of contents heading depth', '2')
  expect(targetSelect.value).toBe(secondKey)
  await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(formats()).toEqual([
    { maxLevel: 6, numbered: false, showTitle: true },
    { maxLevel: 2, numbered: true, showTitle: true },
  ])
  mockEditor.getEditorState().read(() => {
    expect(
      $getSelection()
        ?.getNodes()
        .map((node) => node.getKey()),
    ).toEqual([$getRoot().getFirstChild()!.getKey()])
  })
})

it('focuses the form on open and closes from a checkbox with Escape, restoring the trigger', async () => {
  const button = await mount(1)
  await act(async () => button.click())
  expect(document.activeElement).toBe(element.querySelector('select'))
  const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  checkbox.focus()
  await act(async () => checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(button)
})

it('allows native control mouse focus without bubbling into a ribbon mouse-down canceller', async () => {
  const preventAncestor = jest.fn((event: MouseEvent) => event.preventDefault())
  const ancestor = document.createElement('div')
  document.body.append(ancestor)
  ancestor.append(element)
  ancestor.addEventListener('mousedown', preventAncestor)
  const button = await mount(1)
  await act(async () => button.click())
  const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  checkbox.dispatchEvent(mouseDown)
  expect(mouseDown.defaultPrevented).toBe(false)
  expect(preventAncestor).not.toHaveBeenCalled()
  ancestor.remove()
})
