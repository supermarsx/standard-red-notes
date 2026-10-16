import { createDOMRange } from '@lexical/selection'
import { $isTableCellNode, $isTableSelection } from '@lexical/table'
import { syncCursorPositions, type SyncCursorPositionsFn } from '@lexical/yjs'
import { $getNodeByKey, $getSelection, $isLineBreakNode, $isNodeSelection, $isTextNode } from 'lexical'
import * as Y from 'yjs'

type Binding = Parameters<SyncCursorPositionsFn>[0]
export type SelectionRegions = { kind: 'nodes' | 'table'; positions: ReturnType<typeof Y.relativePositionToJSON>[] }
const MAX_REGIONS = 128

/** Preserve full-width lines and disjoint bidi runs, removing only duplicate boxes. */
export function selectionRects(rects: Iterable<DOMRect>, markSelectedNewlines = false): DOMRect[] {
  const seen = new Set<string>()
  return Array.from(rects)
    .map((rect) => {
      if (markSelectedNewlines && rect.width === 0 && rect.height > 0) {
        return new DOMRect(rect.left, rect.top, 1, rect.height)
      }
      return rect
    })
    .filter((rect) => {
      if (
        ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return false
      }
      const key = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
}

function sharedNodeKey(binding: Binding, position: Y.RelativePosition): string | undefined {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, binding.doc)
  if (!absolute) {
    return
  }
  if ('collabNodeMap' in binding) {
    for (const [key, node] of binding.collabNodeMap) {
      if (node.getSharedType() === absolute.type) {
        return key
      }
    }
  } else {
    const node = binding.mapping.get(absolute.type as Y.XmlElement)
    if (node && !Array.isArray(node)) {
      return node.getKey()
    }
  }
}

function captureRegions(binding: Binding): SelectionRegions | null {
  const selection = $getSelection()
  const table = $isTableSelection(selection)
  if (!table && !$isNodeSelection(selection)) {
    return null
  }
  const candidates = selection.getNodes().filter((node) => (table ? $isTableCellNode(node) : !$isTextNode(node)))
  const keys = new Set(candidates.map((node) => node.getKey()))
  const nodes = candidates.filter((node) => {
    if (table) {
      return true
    }
    for (let parent = node.getParent(); parent; parent = parent.getParent()) {
      if (keys.has(parent.getKey())) {
        return false
      }
    }
    return true
  })
  // Never silently turn a large or unmapped selection into a different selection.
  if (!nodes.length || nodes.length > MAX_REGIONS) {
    return null
  }
  const positions: SelectionRegions['positions'] = []
  for (const node of nodes) {
    const shared =
      'collabNodeMap' in binding
        ? binding.collabNodeMap.get(node.getKey())?.getSharedType()
        : binding.mapping.getSharedType(node)
    if (!shared) {
      return null
    }
    positions.push(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(shared, 0)))
  }
  return { kind: table ? 'table' : 'nodes', positions }
}

function placeBox(element: HTMLElement, rect: DOMRect, origin: DOMRect): void {
  Object.assign(element.style, {
    position: 'absolute',
    pointerEvents: 'none',
    left: `${rect.left - origin.left}px`,
    top: `${rect.top - origin.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

/** Fix range geometry after Lexical resolves encrypted Yjs positions. */
export const syncCollaborationSelectionGeometry: SyncCursorPositionsFn = (binding, provider, options) => {
  const editor = binding.editor
  const root = editor.getRootElement()
  const local = provider.awareness.getLocalState()
  if (local && root) {
    const regions = local.focusing ? editor.getEditorState().read(() => captureRegions(binding)) : null
    if (JSON.stringify(local.selectionRegions ?? null) !== JSON.stringify(regions)) {
      if (!regions) {
        provider.awareness.setLocalStateField('selectionRegions', undefined)
      }
      const { selectionRegions: previousRegions, ...rest } = local
      void previousRegions
      provider.awareness.setLocalState({ ...rest, ...(regions ? { selectionRegions: regions } : {}) })
    }
  }
  syncCursorPositions(binding, provider, options)
  const container = binding.cursorsContainer
  const parent = container?.offsetParent
  if (!root || !container || !parent) {
    return
  }
  const origin = parent.getBoundingClientRect()
  container.querySelectorAll('[data-collaboration-region]').forEach((element) => element.remove())
  editor.getEditorState().read(() => {
    for (const [clientId, cursor] of binding.cursors) {
      const state = provider.awareness.getStates().get(clientId)
      if (!state?.focusing) {
        continue
      }
      const selection = cursor.selection
      if (selection) {
        const anchor = $getNodeByKey(selection.anchor.key)
        const focus = $getNodeByKey(selection.focus.key)
        if (!anchor || !focus) {
          continue
        }
        const range = createDOMRange(editor, anchor, selection.anchor.offset, focus, selection.focus.offset)
        const focusRange = createDOMRange(editor, focus, selection.focus.offset, focus, selection.focus.offset)
        if (!range || !focusRange) {
          continue
        }
        if (!selection.highlight) {
          // Native renderer discards full-width line boxes. Keep raw browser geometry.
          const collapsed =
            selection.anchor.key === selection.focus.key && selection.anchor.offset === selection.focus.offset
          const rects = collapsed || range.collapsed ? [] : selectionRects(range.getClientRects(), true)
          selection.selections.forEach((element) => element.remove())
          selection.selections.length = 0
          for (const rect of rects) {
            const box = root.ownerDocument.createElement('span')
            // Lexical reuses these spans before this post-render pass.
            const background = root.ownerDocument.createElement('span')
            background.hidden = true
            box.append(background)
            placeBox(box, rect, origin)
            box.style.backgroundColor = cursor.color
            box.style.opacity = '0.25'
            container.append(box)
            selection.selections.push(box)
          }
        }
        let caretRect = focusRange.getBoundingClientRect()
        if (caretRect.height === 0 && $isLineBreakNode(focus)) {
          caretRect = editor.getElementByKey(focus.getKey())?.getBoundingClientRect() ?? caretRect
        }
        if (caretRect.height > 0) {
          container.append(selection.caret)
          placeBox(selection.caret, caretRect, origin)
          Object.assign(selection.caret.style, { width: '1px', right: '', bottom: '' })
        } else {
          // Do not invent a caret at the normalized range's opposite endpoint.
          selection.caret.style.visibility = 'hidden'
        }
        if (caretRect.height > 0) {
          selection.caret.style.visibility = ''
        }
      }
      const regions = state.selectionRegions as SelectionRegions | null | undefined
      if (
        !regions ||
        !['nodes', 'table'].includes(regions.kind) ||
        !Array.isArray(regions.positions) ||
        regions.positions.length > MAX_REGIONS
      ) {
        continue
      }
      let labeled = false
      for (const position of regions.positions) {
        let key: string | undefined
        try {
          key = sharedNodeKey(binding, Y.createRelativePositionFromJSON(position))
        } catch {
          continue
        }
        const element = key ? editor.getElementByKey(key) : null
        if (!element || !root.contains(element)) {
          continue
        }
        for (const rect of selectionRects(element.getClientRects())) {
          const box = root.ownerDocument.createElement('span')
          box.dataset.collaborationRegion = regions.kind
          box.dataset.collaborationClientId = String(clientId)
          placeBox(box, rect, origin)
          box.style.backgroundColor = cursor.color
          box.style.opacity = '0.25'
          container.append(box)
          if (!labeled) {
            const label = root.ownerDocument.createElement('span')
            label.dataset.collaborationRegion = regions.kind
            label.textContent = cursor.name
            Object.assign(label.style, {
              position: 'absolute',
              left: `${rect.left - origin.left}px`,
              top: `${rect.top - origin.top - 16}px`,
              backgroundColor: cursor.color,
              color: '#fff',
              fontSize: '12px',
              whiteSpace: 'nowrap',
            })
            container.append(label)
            labeled = true
          }
        }
      }
    }
  })
}
