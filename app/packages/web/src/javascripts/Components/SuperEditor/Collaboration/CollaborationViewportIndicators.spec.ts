/** @jest-environment jsdom */
import type { Provider, SyncCursorPositionsFn } from '@lexical/yjs'
import { createCollaborationViewportIndicators } from './CollaborationViewportIndicators'

const rect = (top: number, height = 16) =>
  ({ top, bottom: top + height, left: 120, right: 121, width: 1, height }) as DOMRect
const viewport = { top: 100, bottom: 300, left: 100, right: 400 }
type Binding = Parameters<SyncCursorPositionsFn>[0]

describe('collaboration viewport indicators', () => {
  let root: HTMLElement
  let pane: HTMLElement
  let container: HTMLElement
  let states: Map<number, { focusing: boolean }>
  let cursors: Map<number, unknown>
  let controller: ReturnType<typeof createCollaborationViewportIndicators>
  let hidden: boolean
  const button = (id: number) => document.querySelector<HTMLButtonElement>(`[data-collaboration-viewport-peer="${id}"]`)
  const update = () =>
    controller.update(
      { clientID: 1, cursors, cursorsContainer: container } as unknown as Binding,
      { clientID: 1, getStates: () => states } as unknown as Provider['awareness'],
      viewport,
    )
  const peer = (id: number, top: number, name = 'Collaborator') => {
    const caret = document.createElement('span')
    caret.getBoundingClientRect = () => rect(top)
    container.append(caret)
    states.set(id, { focusing: true })
    cursors.set(id, { name, color: 'rgb(255, 0, 0)', selection: { caret } })
    return caret
  }

  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    pane = document.createElement('div')
    pane.style.overflowY = 'auto'
    pane.getBoundingClientRect = () => rect(100, 200)
    Object.defineProperties(pane, { clientHeight: { value: 200 }, scrollHeight: { value: 2000 } })
    root = document.createElement('div')
    root.contentEditable = 'true'
    root.tabIndex = -1
    root.textContent = 'Local selection stays here'
    pane.append(root)
    container = document.createElement('div')
    document.body.append(pane, container)
    states = new Map()
    cursors = new Map()
    controller = createCollaborationViewportIndicators({ document, getRoot: () => root })
  })
  afterEach(() => {
    controller.dispose()
    document.body.replaceChildren()
    delete (document as unknown as { hidden?: boolean }).hidden
  })

  it('shows only active offscreen focus, with compact arrows and own-device accessible names', () => {
    peer(1, 20)
    peer(2, 60, 'You (other device · 2)')
    peer(3, 301, '<script>unsafe</script>')
    peer(4, 99) // Partially visible through the toolbar clip.
    peer(5, 200)
    peer(6, 20).style.visibility = 'hidden'
    peer(7, 20)
    states.set(7, { focusing: false })
    update()
    expect(document.querySelectorAll('button')).toHaveLength(2)
    expect(button(2)?.textContent).toBe('↑')
    expect(button(2)?.getAttribute('aria-label')).toContain('You (other device · 2) is working above')
    expect(button(3)?.textContent).toBe('↓')
    expect(button(3)?.title).toContain('<script>unsafe</script>')
    expect(document.querySelector('script')).toBeNull()
    expect(button(2)?.style.top).toBe('100px')
    expect(button(3)?.style.top).toBe('278px')
    expect(button(2)?.parentElement?.style.pointerEvents).toBe('none')
  })

  it('bounds each edge and retains existing buttons across updates', () => {
    for (let id = 2; id < 12; id++) peer(id, id < 7 ? 10 : 400)
    update()
    const original = button(2)
    expect(document.querySelectorAll('button')).toHaveLength(8)
    update()
    expect(button(2)).toBe(original)
    states.delete(2)
    update()
    expect(button(2)).toBeNull()
    expect(button(6)).not.toBeNull()
    controller.update(
      { cursors } as unknown as Binding,
      { clientID: 1, getStates: () => states } as unknown as Provider['awareness'],
      { ...viewport, right: 140 },
    )
    expect(document.querySelectorAll('button')).toHaveLength(2)
  })

  it('scrolls only the necessary nested pane without focusing or changing the local selection', () => {
    const outer = document.createElement('div')
    outer.style.overflowY = 'auto'
    outer.getBoundingClientRect = () => rect(0, 500)
    Object.defineProperties(outer, { clientHeight: { value: 500 }, scrollHeight: { value: 3000 } })
    pane.before(outer)
    outer.append(pane)
    const caret = peer(2, 700)
    caret.getBoundingClientRect = () => rect(700 - pane.scrollTop - outer.scrollTop)
    root.focus()
    expect(document.activeElement).toBe(root)
    const selection = window.getSelection()!
    selection.setBaseAndExtent(root.firstChild!, 2, root.firstChild!, 8)
    const focus = jest.spyOn(root, 'focus')
    update()
    const down = new Event('pointerdown', { bubbles: true, cancelable: true })
    expect(button(2)?.dispatchEvent(down)).toBe(false)
    button(2)?.click()
    expect(pane.scrollTop).toBe(500)
    expect(outer.scrollTop).toBe(0)
    expect(document.activeElement).toBe(root)
    expect(selection.anchorOffset).toBe(2)
    expect(selection.focusOffset).toBe(8)
    expect(focus).not.toHaveBeenCalled()
  })

  it('uses actual non-range region boxes only when no usable caret exists, and suppresses partially visible selections', () => {
    peer(2, 20).style.visibility = 'hidden'
    const region = document.createElement('span')
    region.dataset.collaborationClientId = '2'
    region.getBoundingClientRect = () => rect(500, 40)
    container.append(region)
    update()
    expect(button(2)?.textContent).toBe('↓')
    const visible = region.cloneNode() as HTMLElement
    visible.getBoundingClientRect = () => rect(200, 40)
    container.append(visible)
    update()
    expect(button(2)).toBeNull()
  })

  it('ignores a stale jump after changing editors, even while the old root remains connected', () => {
    peer(2, 700)
    update()
    const oldButton = button(2)!
    root = document.createElement('div')
    pane.append(root)
    oldButton.click()
    expect(pane.scrollTop).toBe(0)
  })

  it('cleans up on hidden, invalid viewport, detached root and disposal without late resurrection', () => {
    peer(2, 20)
    update()
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(button(2)).toBeNull()
    update()
    expect(button(2)).toBeNull()
    hidden = false
    update()
    expect(button(2)).not.toBeNull()
    controller.update(
      { cursors } as unknown as Binding,
      { clientID: 1, getStates: () => states } as unknown as Provider['awareness'],
      { ...viewport, top: NaN },
    )
    expect(button(2)).toBeNull()
    update()
    root.remove()
    update()
    expect(button(2)).toBeNull()
    pane.append(root)
    update()
    controller.dispose()
    update()
    expect(document.querySelector('[data-collaboration-viewport-indicators]')).toBeNull()
  })
})
