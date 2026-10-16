import type { Provider, SyncCursorPositionsFn } from '@lexical/yjs'
import { $getSelection, $isNodeSelection, type LexicalEditor } from 'lexical'
import { $isTableSelection } from '@lexical/table'
import type * as Y from 'yjs'
import { syncCollaborationSelectionGeometry } from './CollaborationSelectionGeometry'
import { createCollaborationViewportIndicators } from './CollaborationViewportIndicators'

/** Keep the body portal inside the visible editor, including nested scroll panes. */
export function clipCursorOverlay(
  overlay: HTMLElement,
  root: HTMLElement,
): { top: number; right: number; bottom: number; left: number } {
  const view = root.ownerDocument.defaultView!
  let { top, right, bottom, left } = root.getBoundingClientRect()
  top = Math.max(0, top)
  left = Math.max(0, left)
  right = Math.min(view.innerWidth, right)
  bottom = Math.min(view.innerHeight, bottom)
  for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent)
    const rect = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, rect.left + parent.clientLeft)
      right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth)
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, rect.top + parent.clientTop)
      bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight)
    }
  }
  overlay.style.visibility = bottom <= top || right <= left ? 'hidden' : 'visible'
  overlay.style.clipPath = `inset(${top}px ${Math.max(0, view.innerWidth - right)}px ${Math.max(0, view.innerHeight - bottom)}px ${left}px)`
  return { top, right, bottom, left }
}

export function cursorLabel(name: string, clientId: number, peerUserUuid?: string, selfUserUuid?: string): string {
  return selfUserUuid && peerUserUuid === selfUserUuid ? `You (other device · ${clientId.toString(36)})` : name
}

/**
 * Reuse Lexical's actual cursor renderer for layout changes, even before the
 * first remote edit. Calling its awareness listeners locally sends no frames.
 * The facade supplies display labels without changing the encrypted presence.
 */
export function createCollaborationCursorTracking(
  actualProvider: Provider,
  editor: LexicalEditor,
  overlay: () => HTMLElement | null,
  selfUserUuid?: string,
): { provider: Provider; dispose(): void } {
  const awareness = actualProvider.awareness
  const cursorListeners = new Set<() => void>()
  const presentations = new Map<number, string>()
  const invalidatedPresentations = new Set<number>()
  const root = editor.getRootElement()
  const doc = root?.ownerDocument ?? document
  const view = doc.defaultView!
  const indicators = createCollaborationViewportIndicators({ document: doc, getRoot: () => editor.getRootElement() })
  let frame: number | undefined
  let disposed = false
  let binding: Parameters<SyncCursorPositionsFn>[0] | undefined
  // Lexical publishes its binding as the origin of local Yjs transactions,
  // including selection-only updates. The public transaction event exposes
  // the actual binding without private React state or fabricated doc edits.
  const ydoc = (actualProvider as Provider & { doc?: Y.Doc }).doc
  const observeBinding = (transaction: Y.Transaction): void => {
    if (disposed) {
      return
    }
    const origin = transaction.origin as Partial<Parameters<SyncCursorPositionsFn>[0]> | null
    if (
      origin &&
      origin.editor === editor &&
      origin.doc === ydoc &&
      typeof origin.cursors?.get === 'function' &&
      typeof origin.cursors.set === 'function' &&
      ('collabNodeMap' in origin || 'mapping' in origin)
    ) {
      binding = origin as Parameters<SyncCursorPositionsFn>[0]
      schedule()
    }
  }
  const paint = () => {
    invalidatedPresentations.clear()
    const currentRoot = editor.getRootElement()
    const container = overlay()
    let viewport: ReturnType<typeof clipCursorOverlay> | undefined
    if (currentRoot && container) {
      viewport = clipCursorOverlay(container, currentRoot)
    } else if (container) {
      container.style.visibility = 'hidden'
    }
    const local = awareness.getLocalState()
    const selection = view.getSelection()
    // A root may already own focus while its canonical document is becoming
    // editable. That transition emits no new DOM focus event for Lexical.
    const nonRangeSelection =
      editor.getEditorState?.().read(() => {
        const current = $getSelection()
        return $isNodeSelection(current) || $isTableSelection(current)
      }) ?? false
    const focusing =
      !!currentRoot &&
      currentRoot.contains(doc.activeElement) &&
      doc.hasFocus() &&
      editor.isEditable() &&
      (nonRangeSelection || (!!selection?.anchorNode && currentRoot.contains(selection.anchorNode)))
    if (local && typeof local.focusing === 'boolean' && local.focusing !== focusing) {
      awareness.setLocalStateField('focusing', focusing)
    }
    cursorListeners.forEach((listener) => listener())
    // Lexical's awareness hook calls the native renderer directly, bypassing
    // the custom doc-update renderer. Reapply geometry after that native pass.
    if (binding) {
      syncCollaborationSelectionGeometry(binding, provider)
    }
    if (binding && viewport) {
      indicators.update(binding, provider.awareness, viewport)
    } else {
      indicators.clear()
    }
  }
  const schedule = () => {
    if (!disposed && frame === undefined) {
      frame = view.requestAnimationFrame(() => {
        frame = undefined
        paint()
      })
    }
  }
  const facade = new Proxy(awareness, {
    get(target, property) {
      if (property === 'getStates') {
        return () => {
          const states: ReturnType<typeof target.getStates> = new Map()
          const live = new Set<number>()
          target.getStates().forEach((state, clientId) => {
            live.add(clientId)
            const peerUserUuid = (state.awarenessData as { userUuid?: string } | undefined)?.userUuid
            // An empty first presence must not create a permanent anonymous
            // cursor. Lexical does not update a cursor's cached name or colour.
            if (!state.name && !peerUserUuid) {
              return
            }
            const name = cursorLabel(state.name || 'Collaborator', clientId, peerUserUuid, selfUserUuid)
            const presentation = JSON.stringify([name, state.color])
            const previous = presentations.get(clientId)
            presentations.set(clientId, presentation)
            if (previous !== undefined && previous !== presentation) {
              invalidatedPresentations.add(clientId)
              schedule()
            }
            if (!invalidatedPresentations.has(clientId)) {
              states.set(clientId, { ...state, name })
            }
          })
          for (const clientId of presentations.keys()) {
            if (!live.has(clientId)) {
              presentations.delete(clientId)
            }
          }
          return states
        }
      }
      if (property === 'on') {
        return (event: 'update', listener: () => void) => {
          if (event === 'update') {
            cursorListeners.add(listener)
            schedule()
          }
          target.on(event, listener)
        }
      }
      if (property === 'off') {
        return (event: 'update', listener: () => void) => {
          cursorListeners.delete(listener)
          target.off(event, listener)
        }
      }
      if (property === 'setLocalState') {
        return (state: ReturnType<typeof target.getLocalState>) => {
          // Lexical replaces local presence on connect/focus. Keep the saver
          // advertisement installed by the room lifetime; null still leaves.
          const saver = target.getLocalState()?.saver
          const previousData = target.getLocalState()?.awarenessData
          const previousRegions = target.getLocalState()?.selectionRegions
          target.setLocalState(
            state
              ? {
                  ...state,
                  ...(saver !== undefined ? { saver } : {}),
                  ...(state.focusing && state.selectionRegions === undefined && previousRegions !== undefined
                    ? { selectionRegions: previousRegions }
                    : {}),
                  awarenessData: {
                    ...previousData,
                    ...state.awarenessData,
                    ...(selfUserUuid ? { userUuid: selfUserUuid } : {}),
                  },
                }
              : null,
          )
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const provider = new Proxy(actualProvider, {
    get(target, property) {
      if (property === 'awareness') {
        return facade
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  doc.addEventListener('scroll', schedule, true)
  doc.addEventListener('focusin', schedule, true)
  doc.addEventListener('focusout', schedule, true)
  doc.addEventListener('selectionchange', schedule)
  doc.addEventListener('visibilitychange', schedule)
  view.addEventListener('focus', schedule)
  view.addEventListener('blur', schedule)
  view.addEventListener('resize', schedule)
  view.visualViewport?.addEventListener('resize', schedule)
  view.visualViewport?.addEventListener('scroll', schedule)
  awareness.on('update', schedule)
  ydoc?.on('afterTransaction', observeBinding)
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  const unregisterRoot = editor.registerRootListener((nextRoot) => {
    resize?.disconnect()
    for (let node = nextRoot; node; node = node.parentElement) {
      resize?.observe(node)
    }
    schedule()
  })
  const unregisterUpdate = editor.registerUpdateListener(schedule)
  const unregisterEditable = editor.registerEditableListener(schedule)
  doc.fonts?.addEventListener('loadingdone', schedule)

  return {
    provider,
    dispose: () => {
      disposed = true
      doc.removeEventListener('scroll', schedule, true)
      doc.removeEventListener('focusin', schedule, true)
      doc.removeEventListener('focusout', schedule, true)
      doc.removeEventListener('selectionchange', schedule)
      doc.removeEventListener('visibilitychange', schedule)
      view.removeEventListener('focus', schedule)
      view.removeEventListener('blur', schedule)
      view.removeEventListener('resize', schedule)
      view.visualViewport?.removeEventListener('resize', schedule)
      view.visualViewport?.removeEventListener('scroll', schedule)
      awareness.off('update', schedule)
      ydoc?.off('afterTransaction', observeBinding)
      binding = undefined
      indicators.dispose()
      doc.fonts?.removeEventListener('loadingdone', schedule)
      resize?.disconnect()
      unregisterRoot()
      unregisterUpdate()
      unregisterEditable()
      cursorListeners.clear()
      presentations.clear()
      invalidatedPresentations.clear()
      if (frame !== undefined) {
        view.cancelAnimationFrame(frame)
        frame = undefined
      }
    },
  }
}
