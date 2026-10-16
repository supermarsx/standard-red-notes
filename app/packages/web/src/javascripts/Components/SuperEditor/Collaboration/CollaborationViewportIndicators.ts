import type { Provider, SyncCursorPositionsFn } from '@lexical/yjs'

type Binding = Parameters<SyncCursorPositionsFn>[0]
export type CollaborationViewport = { top: number; right: number; bottom: number; left: number }
const MAX_PER_EDGE = 4
const BUTTON_SIZE = 22

/** The caller supplies the same clipped viewport used to paint the cursor overlay. */
export function createCollaborationViewportIndicators(options: {
  document: Document
  getRoot: () => HTMLElement | null
}): {
  update(binding: Binding, awareness: Provider['awareness'], viewport: CollaborationViewport): void
  clear(): void
  dispose(): void
} {
  const doc = options.document
  const view = doc.defaultView!
  const layer = doc.createElement('div')
  layer.dataset.collaborationViewportIndicators = ''
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '30' })
  const buttons = new Map<number, HTMLButtonElement>()
  let disposed = false
  const clear = () => {
    buttons.clear()
    layer.replaceChildren()
    layer.remove()
  }
  const onVisibility = () => {
    if (doc.hidden) {
      clear()
    }
  }
  doc.addEventListener('visibilitychange', onVisibility)

  return {
    clear,
    update(binding, awareness, viewport) {
      const root = options.getRoot()
      if (
        disposed ||
        doc.hidden ||
        !root?.isConnected ||
        !Object.values(viewport).every(Number.isFinite) ||
        viewport.bottom - viewport.top < BUTTON_SIZE ||
        viewport.right - viewport.left < BUTTON_SIZE
      ) {
        clear()
        return
      }
      const live = new Set<number>()
      const counts = { above: 0, below: 0 }
      const states = awareness.getStates()
      const regions = [
        ...(binding.cursorsContainer?.querySelectorAll<HTMLElement>('[data-collaboration-client-id]') ?? []),
      ]
      // Stable ordering prevents moving targets as awareness updates arrive.
      for (const [id, cursor] of [...binding.cursors].sort(([a], [b]) => a - b)) {
        const state = states.get(id)
        const caret = cursor.selection?.caret
        if (id === binding.clientID || !state?.focusing) {
          continue
        }
        const usable = (element: HTMLElement) => {
          const style = view.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            element.isConnected &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            [rect.top, rect.bottom, rect.height].every(Number.isFinite) &&
            rect.height > 0
          )
        }
        const elements =
          caret && usable(caret)
            ? [caret]
            : regions.filter((element) => element.dataset.collaborationClientId === String(id) && usable(element))
        if (!elements.length) {
          continue
        }
        const above = elements.every((element) => element.getBoundingClientRect().bottom <= viewport.top)
        const below = elements.every((element) => element.getBoundingClientRect().top >= viewport.bottom)
        const edge = above ? 'above' : below ? 'below' : null
        const targetElement = elements.reduce((nearest, element) => {
          const position = element.getBoundingClientRect().top
          const previous = nearest.getBoundingClientRect().top
          return (above ? position > previous : position < previous) ? element : nearest
        })
        const capacity = Math.min(MAX_PER_EDGE, Math.floor((viewport.right - viewport.left) / BUTTON_SIZE))
        if (!edge || counts[edge] >= capacity) {
          continue
        }
        const index = counts[edge]++
        live.add(id)
        let button = buttons.get(id)
        if (!button) {
          button = doc.createElement('button')
          button.type = 'button'
          button.dataset.collaborationViewportPeer = String(id)
          // A pointer jump must not blur the editor or replace its local selection.
          button.addEventListener('pointerdown', (event) => event.preventDefault())
          buttons.set(id, button)
          layer.append(button)
        }
        const label = `${cursor.name || 'Collaborator'} is working ${edge}. Jump to position.`
        button.title = label
        button.setAttribute('aria-label', label)
        button.textContent = edge === 'above' ? '↑' : '↓'
        Object.assign(button.style, {
          position: 'absolute',
          pointerEvents: 'auto',
          width: `${BUTTON_SIZE}px`,
          height: `${BUTTON_SIZE}px`,
          padding: '0',
          border: '1px solid currentColor',
          borderRadius: '50%',
          background: 'var(--sn-stylekit-background-color, white)',
          color: cursor.color,
          fontSize: '16px',
          lineHeight: '18px',
          cursor: 'pointer',
          left: `${viewport.right - (index + 1) * BUTTON_SIZE}px`,
          top: `${edge === 'above' ? viewport.top : viewport.bottom - BUTTON_SIZE}px`,
        })
        button.onclick = () => {
          if (disposed || doc.hidden || options.getRoot() !== root || !root.isConnected || !targetElement.isConnected) {
            return
          }
          let target = targetElement.getBoundingClientRect().top
          for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
            if (
              !/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY) ||
              parent.scrollHeight <= parent.clientHeight
            ) {
              continue
            }
            const box = parent.getBoundingClientRect()
            const top = Math.max(viewport.top, box.top + parent.clientTop)
            const bottom = Math.min(viewport.bottom, box.top + parent.clientTop + parent.clientHeight)
            if (bottom <= top) {
              continue
            }
            const previous = parent.scrollTop
            parent.scrollTop += target - (top + bottom) / 2
            target -= parent.scrollTop - previous
          }
        }
      }
      for (const [id, button] of buttons) {
        if (!live.has(id)) {
          button.remove()
          buttons.delete(id)
        }
      }
      if (buttons.size) {
        if (!layer.isConnected) {
          doc.body.append(layer)
        }
      } else {
        layer.remove()
      }
    },
    dispose() {
      disposed = true
      doc.removeEventListener('visibilitychange', onVisibility)
      clear()
    },
  }
}
