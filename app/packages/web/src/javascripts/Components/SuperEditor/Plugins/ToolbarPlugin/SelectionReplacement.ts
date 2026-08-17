import { $isListItemNode, $isListNode, ListItemNode } from '@lexical/list'
import {
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  LexicalEditor,
  LexicalNode,
} from 'lexical'
import { $getChecklistItemText, $isChecklistItemNode } from '../../Lexical/Nodes/ChecklistItemNode'

export type SelectionPointSnapshot = { key: string; offset: number; type: 'text' | 'element' }
type SelectionNodeSnapshot = { key: string; parentKey?: string; index: number; serialized: string }
export type ChecklistRowSnapshot = { key: string; parentKey: string; index: number; text: string }
export type SelectionSnapshot = {
  text: string
  anchor: SelectionPointSnapshot
  focus: SelectionPointSnapshot
  checklistRows?: ChecklistRowSnapshot[]
  /** Non-list descendants whose inline structure/formatting must not change while AI runs. */
  checklistContentNodes?: SelectionNodeSnapshot[]
  unsupportedStructuredSelection?: boolean
  sourceNodes: SelectionNodeSnapshot[]
}

export type SelectionReplacementResult =
  'replaced' | 'stale-selection' | 'checklist-shape-mismatch' | 'unsupported-structured-selection'

function $checklistAncestor(node: LexicalNode): ListItemNode | undefined {
  let current: LexicalNode | null = node
  while (current) {
    if ($isChecklistItemNode(current)) {
      return current
    }
    current = current.getParent()
  }
  return undefined
}

function $captureChecklistSelection(selectedText: string): {
  rows?: ChecklistRowSnapshot[]
  contentNodes?: SelectionNodeSnapshot[]
  unsupported: boolean
} {
  const selection = $getSelection()!
  const unique = new Map<string, ListItemNode>()
  const selectedNodes = $isRangeSelection(selection) ? selection.getNodes() : []
  for (const node of selectedNodes) {
    const item = $checklistAncestor(node)
    if (item) {
      unique.set(item.getKey(), item)
    }
  }
  const items = [...unique.values()].sort((left, right) => (left.isBefore(right) ? -1 : right.isBefore(left) ? 1 : 0))
  if (items.length === 0) {
    return { unsupported: false }
  }
  const containsNonChecklistText = selectedNodes.some((node) => $isTextNode(node) && !$checklistAncestor(node))
  const coversWholeRows = selectedText.replaceAll('\r\n', '\n') === items.map($getChecklistItemText).join('\n')
  if (!coversWholeRows) {
    return { unsupported: items.length > 1 || containsNonChecklistText }
  }
  const parent = items[0].getParent()
  if (!parent || items.some((item) => item.getParent()?.getKey() !== parent.getKey())) {
    return { unsupported: true }
  }
  return {
    unsupported: false,
    rows: items.map((item) => ({
      key: item.getKey(),
      parentKey: parent.getKey(),
      index: item.getIndexWithinParent(),
      text: $getChecklistItemText(item),
    })),
    contentNodes: items.flatMap((item) => {
      const snapshots: SelectionNodeSnapshot[] = []
      const visit = (node: LexicalNode) => {
        if ($isListNode(node) || $isListItemNode(node)) {
          return
        }
        snapshots.push($snapshotNode(node))
        if ($isElementNode(node)) {
          node.getChildren().forEach(visit)
        }
      }
      item.getChildren().forEach(visit)
      return snapshots
    }),
  }
}

function $snapshotNode(node: LexicalNode): SelectionNodeSnapshot {
  return {
    key: node.getKey(),
    parentKey: node.getParent()?.getKey(),
    index: node.getIndexWithinParent(),
    serialized: JSON.stringify(node.exportJSON()),
  }
}

export function captureSelectionSnapshot(editor: LexicalEditor): SelectionSnapshot | null {
  let snapshot: SelectionSnapshot | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.isCollapsed()) {
      return
    }
    const text = selection.getTextContent()
    const checklist = $captureChecklistSelection(text)
    snapshot = {
      text,
      anchor: { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type },
      focus: { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type },
      checklistRows: checklist.rows,
      checklistContentNodes: checklist.contentNodes,
      unsupportedStructuredSelection: checklist.unsupported,
      sourceNodes: selection.getNodes().map($snapshotNode),
    }
  })
  return snapshot
}

function $pointStillValid(point: SelectionPointSnapshot): boolean {
  const node = $getNodeByKey(point.key)
  if (point.type === 'text') {
    return Boolean($isTextNode(node) && point.offset >= 0 && point.offset <= node.getTextContentSize())
  }
  return Boolean($isElementNode(node) && point.offset >= 0 && point.offset <= node.getChildrenSize())
}

function normalizedReplacementLines(replacement: string): string[] {
  return replacement.replaceAll('\r\n', '\n').split('\n')
}

function $sourceNodesStillMatch(sourceNodes: SelectionNodeSnapshot[]): boolean {
  return sourceNodes.every((snapshot) => {
    const node = $getNodeByKey(snapshot.key)
    return Boolean(
      node &&
      node.getParent()?.getKey() === snapshot.parentKey &&
      node.getIndexWithinParent() === snapshot.index &&
      JSON.stringify(node.exportJSON()) === snapshot.serialized,
    )
  })
}

function $rewriteChecklistRows(snapshot: SelectionSnapshot, replacement: string): SelectionReplacementResult {
  const rows = snapshot.checklistRows!
  const lines = normalizedReplacementLines(replacement)
  if (lines.length !== rows.length) {
    return 'checklist-shape-mismatch'
  }

  // Row text alone cannot detect a same-text formatting/link change that lands
  // while the provider is running. Preserve the realtime edit by failing closed
  // before rewriting any row. Checklist containers are intentionally excluded
  // so a concurrent checked/due/recurrence update remains attached and wins.
  if (!$sourceNodesStillMatch(snapshot.checklistContentNodes ?? snapshot.sourceNodes)) {
    return 'stale-selection'
  }

  const liveRows: ListItemNode[] = []
  for (const row of rows) {
    const node = $getNodeByKey(row.key)
    if (
      !$isChecklistItemNode(node) ||
      node.getParent()?.getKey() !== row.parentKey ||
      node.getIndexWithinParent() !== row.index ||
      $getChecklistItemText(node) !== row.text
    ) {
      return 'stale-selection'
    }
    liveRows.push(node)
  }

  for (let index = 0; index < liveRows.length; index += 1) {
    const item = liveRows[index]
    const nestedList = item.getChildren().find($isListNode)
    for (const child of item.getChildren()) {
      if (!$isListNode(child)) {
        child.remove()
      }
    }
    const text = $createTextNode(lines[index])
    if (nestedList?.isAttached()) {
      nestedList.insertBefore(text)
    } else {
      item.append(text)
    }
  }
  return 'replaced'
}

/**
 * Replace only if the async request's original selection is still byte-for-byte
 * current. Full checklist-row selections are rewritten in place, preserving
 * every ListItemNode and its checked/todo/due/recurrence NodeState.
 */
export function restoreAndReplaceSelection(
  editor: LexicalEditor,
  snapshot: SelectionSnapshot,
  replacement: string,
): SelectionReplacementResult {
  let result: SelectionReplacementResult = 'stale-selection'
  editor.update(
    () => {
      if (snapshot.unsupportedStructuredSelection) {
        result = 'unsupported-structured-selection'
        return
      }
      if (snapshot.checklistRows?.length) {
        result = $rewriteChecklistRows(snapshot, replacement)
        return
      }
      if (
        !$pointStillValid(snapshot.anchor) ||
        !$pointStillValid(snapshot.focus) ||
        !$sourceNodesStillMatch(snapshot.sourceNodes)
      ) {
        return
      }
      const selection = $createRangeSelection()
      selection.anchor.set(snapshot.anchor.key, snapshot.anchor.offset, snapshot.anchor.type)
      selection.focus.set(snapshot.focus.key, snapshot.focus.offset, snapshot.focus.type)
      $setSelection(selection)
      if (selection.getTextContent() !== snapshot.text) {
        $setSelection(null)
        return
      }
      selection.insertText(replacement)
      result = 'replaced'
    },
    { discrete: true },
  )
  return result
}
