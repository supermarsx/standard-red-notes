/** @jest-environment jsdom */
import { act, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import BlockZoomOverlay from './BlockZoomOverlay'

let mockLive: HTMLElement | null
let mockUpdate: (() => void) | undefined
const mockUnregister = jest.fn()
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/StyledTooltip/StyledTooltip', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}))
const mockEditor = {
  getEditorState: () => ({ read: (callback: () => void) => callback() }),
  getElementByKey: () => mockLive,
  registerUpdateListener: (callback: () => void) => {
    mockUpdate = callback
    return mockUnregister
  },
}

let root: Root
let container: HTMLDivElement
let portal: HTMLDivElement
let pending: Map<number, FrameRequestCallback>
let sequence = 0
const flushFrames = async () => {
  await act(async () => {
    await Promise.resolve()
    const callbacks = [...pending.values()]
    pending.clear()
    callbacks.forEach((callback) => callback(0))
  })
}
const liveBlock = (width = 600) => {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  element.innerHTML =
    '<div class="mermaid-viewport" style="position:relative;width:100%;height:300px"><div style="position:absolute;width:100%"></div></div>'
  Object.defineProperty(element, 'offsetWidth', { get: () => width })
  document.body.appendChild(element)
  return element
}
beforeEach(() => {
  pending = new Map()
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    pending.set(++sequence, callback)
    return sequence
  })
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    pending.delete(id)
  })
  container = document.createElement('div')
  portal = document.createElement('div')
  document.body.append(container, portal)
  root = createRoot(container)
  mockLive = liveBlock()
  mockUpdate = undefined
  mockUnregister.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  mockLive?.remove()
  container.remove()
  portal.remove()
  jest.restoreAllMocks()
})
const open = async () => {
  await act(async () =>
    root.render(
      <BlockZoomOverlay blockKey="diagram" label="Mermaid" onClose={() => undefined} portalElement={portal} />,
    ),
  )
}

it('preserves the live width for absolute-positioned diagram snapshots without moving the live DOM', async () => {
  await open()
  const host = portal.querySelector<HTMLElement>('.super-block-zoom-clone')!
  expect(host.style.width).toBe('600px')
  expect(host.firstElementChild).not.toBe(mockLive)
  expect(mockLive?.parentElement).toBe(document.body)
  expect(host.firstElementChild?.getAttribute('contenteditable')).toBeNull()
})

it('refreshes after asynchronous Mermaid rendering without a Lexical edit and batches DOM mutations', async () => {
  await open()
  const viewport = mockLive!.querySelector('.mermaid-viewport')!
  await act(async () => {
    viewport.innerHTML = '<svg viewBox="0 0 600 300"><text>Rendered later</text></svg>'
    viewport.setAttribute('data-render', 'ready')
    await Promise.resolve()
  })
  expect(pending.size).toBe(1)
  await flushFrames()
  expect(portal.querySelector('svg text')?.textContent).toBe('Rendered later')
  expect(pending.size).toBe(0)
})

it('recovers a block that temporarily disappears and disconnects observation on close', async () => {
  await open()
  const original = mockLive!
  mockLive = null
  mockUpdate?.()
  await flushFrames()
  expect(portal.textContent).toContain('This block is no longer available.')
  mockLive = original
  mockUpdate?.()
  await flushFrames()
  expect(portal.textContent).not.toContain('This block is no longer available.')
  expect(portal.querySelector('.super-block-zoom-clone')?.firstElementChild).not.toBeNull()
  mockUpdate?.()
  expect(pending.size).toBe(1)
  await act(async () =>
    root.render(<BlockZoomOverlay blockKey={null} label="Mermaid" onClose={() => undefined} portalElement={portal} />),
  )
  await act(async () => {
    original.appendChild(document.createElement('svg'))
    await Promise.resolve()
  })
  expect(pending.size).toBe(0)
  expect(mockUnregister).toHaveBeenCalledTimes(1)
})
