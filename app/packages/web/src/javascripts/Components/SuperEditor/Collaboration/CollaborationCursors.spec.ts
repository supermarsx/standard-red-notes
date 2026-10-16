/** @jest-environment jsdom */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { Provider } from '@lexical/yjs'
import type { LexicalEditor } from 'lexical'
import { clipCursorOverlay, createCollaborationCursorTracking, cursorLabel } from './CollaborationCursors'
import { syncCollaborationSelectionGeometry } from './CollaborationSelectionGeometry'

jest.mock('./CollaborationSelectionGeometry', () => ({ syncCollaborationSelectionGeometry: jest.fn() }))

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  x: left,
  y: top,
  toJSON: () => ({}),
})

let root: HTMLElement
let pane: HTMLElement
let overlay: HTMLElement
let doc: Y.Doc
let awareness: Awareness
let editor: LexicalEditor
let onEditorUpdate: () => void
let onEditable: () => void
let editable: boolean
let rootListener: (root: HTMLElement | null) => void
let resizeCallback: () => void
let resizeDisconnect: jest.Mock
let dispose: (() => void) | undefined

beforeEach(() => {
  jest.useFakeTimers()
  pane = document.createElement('div')
  pane.style.overflow = 'auto'
  root = document.createElement('div')
  overlay = document.createElement('div')
  pane.append(root)
  document.body.append(pane, overlay)
  root.getBoundingClientRect = () => rect(10, 20, 300, 600)
  pane.getBoundingClientRect = () => rect(0, 0, 400, 200)
  Object.defineProperties(pane, { clientWidth: { value: 400 }, clientHeight: { value: 200 } })
  doc = new Y.Doc()
  awareness = new Awareness(doc)
  resizeDisconnect = jest.fn()
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe = jest.fn()
      disconnect = resizeDisconnect
    },
  })
  editor = {
    isEditable: () => editable,
    registerEditableListener: (listener: () => void) => {
      onEditable = listener
      return jest.fn()
    },
    getRootElement: () => root,
    registerUpdateListener: (listener: () => void) => {
      onEditorUpdate = listener
      return jest.fn()
    },
    registerRootListener: (listener: (root: HTMLElement | null) => void) => {
      rootListener = listener
      listener(root)
      return jest.fn()
    },
  } as unknown as LexicalEditor
  editable = true
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  awareness.destroy()
  doc.destroy()
  document.body.replaceChildren()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  jest.useRealTimers()
})

function tracking() {
  const provider = {
    doc,
    awareness,
    connect: jest.fn(),
    disconnect: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as Provider
  const tracker = createCollaborationCursorTracking(provider, editor, () => overlay, 'self')
  dispose = tracker.dispose
  return { provider, tracker }
}

it('reapplies custom geometry after the real native awareness listener using the local transaction binding, without a remote edit', () => {
  const { tracker } = tracking()
  const nativePaint = jest.fn()
  tracker.provider.awareness.on('update', nativePaint)
  const binding = { editor, doc, cursors: new Map(), collabNodeMap: new Map() }
  doc.transact(() => {}, binding)
  jest.advanceTimersByTime(20)
  const customPaint = jest.mocked(syncCollaborationSelectionGeometry)
  expect(customPaint).toHaveBeenLastCalledWith(binding, tracker.provider)
  expect(nativePaint.mock.invocationCallOrder.at(-1)).toBeLessThan(customPaint.mock.invocationCallOrder.at(-1)!)
  nativePaint.mockClear()
  customPaint.mockClear()
  awareness.setLocalStateField('focusing', false)
  jest.advanceTimersByTime(20)
  expect(nativePaint).toHaveBeenCalled()
  expect(customPaint).toHaveBeenCalledWith(binding, tracker.provider)
  tracker.dispose()
  customPaint.mockClear()
  doc.transact(() => {}, binding)
  jest.advanceTimersByTime(20)
  expect(customPaint).not.toHaveBeenCalled()
})

it('clips to the editor and its nested scrolling viewport, and hides an offscreen editor', () => {
  clipCursorOverlay(overlay, root)
  expect(overlay.style.clipPath).toBe(`inset(20px ${window.innerWidth - 310}px ${window.innerHeight - 200}px 10px)`)
  expect(overlay.style.visibility).toBe('visible')
  root.getBoundingClientRect = () => rect(10, -700, 300, 600)
  clipCursorOverlay(overlay, root)
  expect(overlay.style.visibility).toBe('hidden')
})

it('repaints after scrolling before any remote document edit and coalesces rapid scroll events', () => {
  const { tracker } = tracking()
  const repaint = jest.fn()
  tracker.provider.awareness.on('update', repaint)
  jest.advanceTimersByTime(20)
  repaint.mockClear()
  root.getBoundingClientRect = () => rect(10, 50, 300, 600)
  root.dispatchEvent(new Event('scroll'))
  pane.dispatchEvent(new Event('scroll'))
  expect(repaint).not.toHaveBeenCalled()
  jest.advanceTimersByTime(20)
  expect(repaint).toHaveBeenCalledTimes(1)
  expect(overlay.style.clipPath).toContain('inset(50px')
  tracker.provider.awareness.off('update', repaint)
  window.dispatchEvent(new Event('resize'))
  jest.advanceTimersByTime(20)
  expect(repaint).toHaveBeenCalledTimes(1)
})

it('excludes the editor root’s own borders and scrollbar from the visible cursor area', () => {
  root.style.overflowY = 'auto'
  root.style.overflowX = 'auto'
  Object.defineProperties(root, {
    clientLeft: { value: 2 },
    clientTop: { value: 3 },
    clientWidth: { value: 280 },
    clientHeight: { value: 570 },
  })
  expect(clipCursorOverlay(overlay, root)).toEqual({ top: 23, right: 292, bottom: 200, left: 12 })
})

it('updates minimal offscreen indicators from the same clipped cursor paint and removes them with the editor', () => {
  const { tracker } = tracking()
  const caret = document.createElement('span')
  let caretTop = -40
  caret.getBoundingClientRect = () => rect(40, caretTop, 1, 16)
  overlay.append(caret)
  awareness.states.set(20, { focusing: true, name: 'Ada' })
  const binding = {
    editor,
    doc,
    collabNodeMap: new Map(),
    cursorsContainer: overlay,
    cursors: new Map([[20, { name: 'Ada', color: 'red', selection: { caret } }]]),
  }
  doc.transact(() => {}, binding)
  jest.advanceTimersByTime(20)
  const indicator = () => document.querySelector<HTMLButtonElement>('[data-collaboration-viewport-peer="20"]')
  expect(indicator()?.textContent).toBe('↑')
  expect(indicator()?.title).toContain('Ada is working above')
  expect(indicator()?.style.top).toBe('20px')
  caretTop = 300
  pane.dispatchEvent(new Event('scroll'))
  jest.advanceTimersByTime(20)
  expect(indicator()?.textContent).toBe('↓')
  expect(indicator()?.style.top).toBe('178px')
  caretTop = 100
  pane.dispatchEvent(new Event('scroll'))
  jest.advanceTimersByTime(20)
  expect(indicator()).toBeNull()
  caretTop = -40
  pane.dispatchEvent(new Event('scroll'))
  jest.advanceTimersByTime(20)
  expect(indicator()).not.toBeNull()
  tracker.dispose()
  expect(indicator()).toBeNull()
  expect(document.querySelector('[data-collaboration-viewport-indicators]')).toBeNull()
})

it('follows reflow, local document updates, window resizing and replacement editor roots', () => {
  const { tracker } = tracking()
  const repaint = jest.fn()
  tracker.provider.awareness.on('update', repaint)
  jest.advanceTimersByTime(20)
  repaint.mockClear()
  resizeCallback()
  onEditorUpdate()
  rootListener(root)
  window.dispatchEvent(new Event('resize'))
  jest.advanceTimersByTime(20)
  expect(repaint).toHaveBeenCalledTimes(1)
  expect(resizeDisconnect).toHaveBeenCalled()
  tracker.dispose()
  repaint.mockClear()
  resizeCallback()
  root.dispatchEvent(new Event('scroll'))
  jest.advanceTimersByTime(20)
  expect(repaint).not.toHaveBeenCalled()
})

it('renders distinct own-device labels without mutating received presence or hiding either device', () => {
  awareness.states.set(20, { name: 'me@example.com', awarenessData: { userUuid: 'self' }, focusing: true })
  awareness.states.set(21, { name: 'me@example.com', awarenessData: { userUuid: 'self' }, focusing: true })
  awareness.states.set(22, { name: '<script>Ada</script>', awarenessData: { userUuid: 'ada' }, focusing: true })
  const { tracker } = tracking()
  const states = tracker.provider.awareness.getStates()
  expect(states.get(20)?.name).toBe('You (other device · k)')
  expect(states.get(21)?.name).toBe('You (other device · l)')
  expect(states.get(22)?.name).toBe('<script>Ada</script>')
  expect(awareness.getStates().get(20)?.name).toBe('me@example.com')
  expect(cursorLabel('Unknown', 1, undefined, undefined)).toBe('Unknown')
})

it('preserves the elected-saver advertisement when Lexical replaces its local state and clears on departure', () => {
  const saver = { userUuid: 'self', leaseId: 'lease', canSaveOverSocket: true, canonicalReady: true }
  awareness.setLocalState({ saver, name: 'self', awarenessData: { userUuid: 'self', stateReady: true } })
  const { tracker } = tracking()
  tracker.provider.awareness.setLocalState({ name: 'new-name', focusing: true } as never)
  expect(awareness.getLocalState()).toEqual({
    saver,
    name: 'new-name',
    focusing: true,
    awarenessData: { userUuid: 'self', stateReady: true },
  })
  tracker.provider.awareness.setLocalState(null)
  expect(awareness.getLocalState()).toBeNull()
})

it('uses the existing provider lifecycle and unregisters queued layout paints on disposal', () => {
  const { provider, tracker } = tracking()
  tracker.provider.disconnect()
  expect(provider.disconnect).toHaveBeenCalledTimes(1)
  const repaint = jest.fn()
  tracker.provider.awareness.on('update', repaint)
  tracker.dispose()
  jest.advanceTimersByTime(20)
  expect(repaint).not.toHaveBeenCalled()
})

it('preserves encrypted nonrange selection during Lexical focus updates and lets deliberate range clearing remove it', () => {
  const selectionRegions = { kind: 'nodes', positions: [{ tname: 'root', assoc: 0 }] }
  awareness.setLocalState({ name: 'self', focusing: true, selectionRegions })
  const { tracker } = tracking()
  tracker.provider.awareness.setLocalState({ name: 'self', focusing: true, anchorPos: null, focusPos: null } as never)
  expect(awareness.getLocalState()?.selectionRegions).toEqual(selectionRegions)
  tracker.provider.awareness.setLocalStateField('selectionRegions', undefined)
  tracker.provider.awareness.setLocalState({ name: 'self', focusing: true, anchorPos: null, focusPos: null } as never)
  expect(Object.hasOwn(awareness.getLocalState()!, 'selectionRegions')).toBe(false)
})

it('does not cache an anonymous cursor before a newly joined own device identifies itself', () => {
  awareness.states.set(20, { focusing: false })
  const { tracker } = tracking()
  expect(tracker.provider.awareness.getStates().has(20)).toBe(false)
  awareness.states.set(20, { name: 'me@example.com', awarenessData: { userUuid: 'self' }, focusing: true })
  expect(tracker.provider.awareness.getStates().get(20)?.name).toBe('You (other device · k)')
})

it('recreates a cached cursor after identity changes so the actual renderer receives its own-device label', () => {
  awareness.states.set(20, { name: 'me@example.com', focusing: true })
  const { tracker } = tracking()
  let cachedName: string | undefined
  // Lexical keeps cursor.name from first creation until that client is removed.
  const lexicalRenderer = () => {
    const state = tracker.provider.awareness.getStates().get(20)
    if (!state) {
      cachedName = undefined
    } else if (cachedName === undefined) {
      cachedName = state.name
    }
  }
  tracker.provider.awareness.on('update', lexicalRenderer)
  jest.advanceTimersByTime(20)
  expect(cachedName).toBe('me@example.com')
  awareness.states.set(20, { name: 'me@example.com', awarenessData: { userUuid: 'self' }, focusing: true })
  lexicalRenderer()
  expect(cachedName).toBeUndefined()
  jest.advanceTimersByTime(20)
  expect(cachedName).toBe('You (other device · k)')
})

it('publishes real caret focus after a previously focused editor becomes writable, without inventing focus outside its selection', () => {
  root.textContent = 'real caret'
  root.tabIndex = 0
  root.focus()
  jest.spyOn(document, 'hasFocus').mockReturnValue(true)
  const range = document.createRange()
  range.setStart(root.firstChild!, 3)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  awareness.setLocalState({ focusing: false, name: 'self', awarenessData: { userUuid: 'self' } })
  editable = false
  tracking()
  jest.advanceTimersByTime(20)
  expect(awareness.getLocalState()?.focusing).toBe(false)
  editable = true
  onEditable()
  jest.advanceTimersByTime(40)
  expect(awareness.getLocalState()?.focusing).toBe(true)
  window.getSelection()!.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  jest.advanceTimersByTime(40)
  expect(awareness.getLocalState()?.focusing).toBe(false)
})
