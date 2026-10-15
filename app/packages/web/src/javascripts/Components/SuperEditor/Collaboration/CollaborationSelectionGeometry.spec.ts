/** @jest-environment jsdom */
import { createDOMRange } from '@lexical/selection'
import {
  $createTableNode,
  $createTableRowNode,
  $createTableCellNode,
  $createTableSelectionFrom,
  TableNode,
  TableRowNode,
  TableCellNode,
} from '@lexical/table'
import { syncCursorPositions, type Provider, type SyncCursorPositionsFn } from '@lexical/yjs'
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
} from 'lexical'
import * as Y from 'yjs'
import { selectionRects, syncCollaborationSelectionGeometry } from './CollaborationSelectionGeometry'

jest.mock('@lexical/yjs', () => ({ ...jest.requireActual('@lexical/yjs'), syncCursorPositions: jest.fn() }))
jest.mock('@lexical/selection', () => ({ ...jest.requireActual('@lexical/selection'), createDOMRange: jest.fn() }))

const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height)
type Binding = Parameters<SyncCursorPositionsFn>[0]

it('renders selected newline zero-width browser rectangles as minimal markers without fabricating a full row', () => {
  const newline = rect(20, 40, 0, 17)
  expect(selectionRects([newline])).toEqual([])
  expect(selectionRects([newline, rect(20, 40, 0, 17)], true)).toEqual([rect(20, 40, 1, 17)])
  expect(selectionRects([rect(20, 40, 0, 0)], true)).toEqual([])
})

it('keeps full-width multiline and disjoint bidi boxes, excluding duplicates and empty or nonfinite boxes', () => {
  const line = rect(10, 20, 400, 18)
  const bidi = rect(330, 40, 80, 18)
  expect(
    selectionRects([line, rect(10, 20, 400, 18), bidi, rect(10, 40, 90, 18), rect(0, 0, 0, 0), rect(NaN, 0, 1, 1)]),
  ).toEqual([line, bidi, rect(10, 40, 90, 18)])
})

it('renders every browser range line and puts backward selection caret at the actual focus rather than the last rectangle', () => {
  const root = document.createElement('div')
  const outer = document.createElement('div')
  const container = document.createElement('div')
  document.body.append(root, outer)
  outer.append(container)
  Object.defineProperty(container, 'offsetParent', { value: outer })
  outer.getBoundingClientRect = () => rect(0, 0, 800, 800)
  const editor = createEditor({
    namespace: 'range-geometry',
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  let key = ''
  editor.update(
    () => {
      const text = $createTextNode('selected multiline text')
      key = text.getKey()
      $getRoot().append($createParagraphNode().append(text))
    },
    { discrete: true },
  )
  const caret = document.createElement('span')
  const selection = {
    anchor: { key, offset: 20 },
    focus: { key, offset: 2 },
    caret,
    selections: [] as HTMLElement[],
    highlight: null,
  }
  const states = new Map([[2, { focusing: true, name: 'peer', color: '#ff0000' }]])
  const provider = { awareness: { getStates: () => states, getLocalState: () => null } } as unknown as Provider
  const binding = {
    editor,
    cursorsContainer: container,
    cursors: new Map([[2, { name: 'peer', color: '#ff0000', selection }]]),
  } as unknown as Binding
  const lines = [rect(10, 20, 400, 18), rect(10, 38, 400, 18), rect(10, 56, 90, 18)]
  jest
    .mocked(createDOMRange)
    .mockReturnValueOnce({ collapsed: false, getClientRects: () => lines } as unknown as Range)
    .mockReturnValueOnce({ getBoundingClientRect: () => rect(35, 20, 0, 18) } as Range)
  syncCollaborationSelectionGeometry(binding, provider)
  expect(syncCursorPositions).toHaveBeenCalledWith(binding, provider, undefined)
  expect(selection.selections).toHaveLength(3)
  expect(selection.selections[1].style.width).toBe('400px')
  expect(caret.parentNode).toBe(container)
  expect(caret.style.left).toBe('35px')
  expect(caret.style.top).toBe('20px')
  expect(caret.style.right).toBe('')
  expect(jest.mocked(createDOMRange).mock.calls.at(-1)?.slice(2)).toEqual([2, expect.anything(), 2])
  // Empty-paragraph DOM ranges can expand around a BR even when the actual
  // Lexical selection is collapsed. That caret is not a selected newline.
  selection.anchor.offset = 2
  jest
    .mocked(createDOMRange)
    .mockReturnValueOnce({ collapsed: false, getClientRects: () => [rect(35, 20, 0, 18)] } as unknown as Range)
    .mockReturnValueOnce({ getBoundingClientRect: () => rect(35, 20, 0, 18) } as Range)
  syncCollaborationSelectionGeometry(binding, provider)
  expect(selection.selections).toHaveLength(0)
  expect(caret.parentNode).toBe(container)
  editor.setRootElement(null)
  root.remove()
  outer.remove()
})

it('publishes selected block identities as Yjs positions and removes the field when selection becomes a range or disappears', () => {
  const root = document.createElement('div')
  document.body.append(root)
  const editor = createEditor({
    namespace: 'node-geometry',
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  const doc = new Y.Doc()
  const shared = doc.get('selected-block', Y.XmlText)
  let key = ''
  editor.update(
    () => {
      const paragraph = $createParagraphNode().append($createTextNode('secret note text'))
      key = paragraph.getKey()
      $getRoot().append(paragraph)
      const selection = $createNodeSelection()
      selection.add(key)
      $setSelection(selection)
    },
    { discrete: true },
  )
  let local: Record<string, unknown> = { focusing: true, saver: { leaseId: 'lease' } }
  const provider = {
    awareness: {
      getLocalState: () => local,
      getStates: () => new Map(),
      setLocalState: (state: Record<string, unknown>) => {
        local = state
      },
      setLocalStateField: (field: string, value: unknown) => {
        local[field] = value
      },
    },
  } as unknown as Provider
  const binding = {
    editor,
    doc,
    cursorsContainer: null,
    collabNodeMap: new Map([[key, { getSharedType: () => shared }]]),
  } as unknown as Binding
  syncCollaborationSelectionGeometry(binding, provider)
  expect(local.selectionRegions).toEqual({
    kind: 'nodes',
    positions: [Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(shared, 0))],
  })
  expect(JSON.stringify(local.selectionRegions)).not.toContain('secret')
  expect(local.selectionRegions).not.toHaveProperty('key')
  expect(local.saver).toEqual({ leaseId: 'lease' })
  editor.update(() => $setSelection(null), { discrete: true })
  syncCollaborationSelectionGeometry(binding, provider)
  expect(Object.hasOwn(local, 'selectionRegions')).toBe(false)
  editor.setRootElement(null)
  root.remove()
  doc.destroy()
})

it('captures a rectangular table selection as individual cell identities, including an empty cell', () => {
  const root = document.createElement('div')
  document.body.append(root)
  const editor = createEditor({
    namespace: 'table-geometry',
    nodes: [TableNode, TableRowNode, TableCellNode],
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  const doc = new Y.Doc()
  const mappings = new Map()
  editor.update(
    () => {
      const table = $createTableNode()
      const row = $createTableRowNode()
      const first = $createTableCellNode().append($createParagraphNode().append($createTextNode('private cell')))
      const empty = $createTableCellNode().append($createParagraphNode())
      table.append(row.append(first, empty))
      $getRoot().append(table)
      for (const [index, cell] of [first, empty].entries()) {
        const shared = doc.get(`cell-${index}`, Y.XmlText)
        mappings.set(cell.getKey(), { getSharedType: () => shared })
      }
      $setSelection($createTableSelectionFrom(table, first, empty))
    },
    { discrete: true },
  )
  let local: Record<string, unknown> = { focusing: true }
  const provider = {
    awareness: {
      getLocalState: () => local,
      getStates: () => new Map(),
      setLocalState: (state: Record<string, unknown>) => {
        local = state
      },
    },
  } as unknown as Provider
  syncCollaborationSelectionGeometry(
    { editor, doc, cursorsContainer: null, collabNodeMap: mappings } as unknown as Binding,
    provider,
  )
  expect(local.selectionRegions).toEqual({
    kind: 'table',
    positions: [
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.get('cell-0', Y.XmlText), 0)),
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.get('cell-1', Y.XmlText), 0)),
    ],
  })
  expect(JSON.stringify(local.selectionRegions)).not.toContain('private')
  editor.setRootElement(null)
  root.remove()
  doc.destroy()
})

it('renders remote block geometry with the own-device label and removes it immediately on departure', () => {
  const root = document.createElement('div')
  const outer = document.createElement('div')
  const container = document.createElement('div')
  document.body.append(root, outer)
  outer.append(container)
  Object.defineProperty(container, 'offsetParent', { value: outer })
  outer.getBoundingClientRect = () => rect(0, 0, 800, 800)
  const editor = createEditor({
    namespace: 'remote-node',
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  let key = ''
  editor.update(
    () => {
      const node = $createParagraphNode().append($createTextNode('private text'))
      key = node.getKey()
      $getRoot().append(node)
    },
    { discrete: true },
  )
  editor.getElementByKey(key)!.getClientRects = () => [rect(20, 35, 250, 42)] as unknown as DOMRectList
  const doc = new Y.Doc()
  const shared = doc.get('block', Y.XmlText)
  const states = new Map([
    [
      2,
      {
        focusing: true,
        selectionRegions: {
          kind: 'nodes',
          positions: [Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(shared, 0))],
        },
      },
    ],
  ])
  const provider = { awareness: { getLocalState: () => null, getStates: () => states } } as unknown as Provider
  const binding = {
    editor,
    doc,
    collabNodeMap: new Map([[key, { getSharedType: () => shared }]]),
    cursorsContainer: container,
    cursors: new Map([[2, { name: 'You (other device · 2)', color: '#ff0000', selection: null }]]),
  } as unknown as Binding
  syncCollaborationSelectionGeometry(binding, provider)
  const boxes = container.querySelectorAll('[data-collaboration-region]')
  expect(boxes).toHaveLength(2)
  expect((boxes[0] as HTMLElement).style.height).toBe('42px')
  expect(boxes[1].textContent).toBe('You (other device · 2)')
  expect(container.textContent).not.toContain('private')
  states.clear()
  syncCollaborationSelectionGeometry(binding, provider)
  expect(container.childElementCount).toBe(0)
  editor.setRootElement(null)
  root.remove()
  outer.remove()
  doc.destroy()
})
