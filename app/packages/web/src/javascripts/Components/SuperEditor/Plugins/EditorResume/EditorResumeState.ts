import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
} from 'lexical'
import {
  readRelativeResumeSelection,
  resolveRelativeResumeSelection,
  type RelativeResumeSelection,
} from './EditorResumeCollaboration'

type ResumePoint = { path: number[]; offset: number; type: 'text' | 'element' }
export type EditorResumeState = {
  version: 1
  lastInteractionAt?: number
  scroll: { rootTop: number; rootLeft: number; outerTop: number; outerLeft: number }
  selection?: { anchor: ResumePoint; focus: ResumePoint; relative?: RelativeResumeSelection }
}

function pointState(point: PointType): ResumePoint | undefined {
  const path: number[] = []
  let node = point.getNode()
  while (node.getKey() !== 'root') {
    const parent = node.getParent()
    if (!parent || path.length >= 64) {
      return
    }
    path.unshift(node.getIndexWithinParent())
    node = parent
  }
  return { path, offset: point.offset, type: point.type }
}

function resolvePoint(point: ResumePoint) {
  let node: LexicalNode = $getRoot()
  for (const index of point.path) {
    if (!$isElementNode(node)) {
      break
    }
    const children = node.getChildren()
    if (!children.length) {
      break
    }
    node = children[Math.min(index, children.length - 1)]
  }
  return clampPoint(node, point.offset)
}

function clampPoint(node: LexicalNode, offset: number) {
  if ($isTextNode(node)) {
    return { key: node.getKey(), offset: Math.min(offset, node.getTextContentSize()), type: 'text' as const }
  }
  if ($isElementNode(node)) {
    return { key: node.getKey(), offset: Math.min(offset, node.getChildrenSize()), type: 'element' as const }
  }
  const parent = node.getParent()
  return parent ? { key: parent.getKey(), offset: node.getIndexWithinParent(), type: 'element' as const } : undefined
}

export function captureEditorResumeScroll(root: HTMLElement): EditorResumeState['scroll'] {
  const outer = root.closest<HTMLElement>('.editor-scroller')
  return {
    rootTop: root.scrollTop,
    rootLeft: root.scrollLeft,
    outerTop: outer?.scrollTop ?? 0,
    outerLeft: outer?.scrollLeft ?? 0,
  }
}

export function captureEditorResume(
  editor: LexicalEditor,
  previous?: EditorResumeState,
  root = editor.getRootElement(),
): EditorResumeState | undefined {
  if (!root) {
    return
  }
  return editor.getEditorState().read(() => {
    const selected = $getSelection()
    let selection = previous?.selection
    if ($isRangeSelection(selected)) {
      const anchor = pointState(selected.anchor)
      const focus = pointState(selected.focus)
      if (anchor && focus) {
        selection = { anchor, focus, relative: readRelativeResumeSelection(editor, selected) }
      }
    }
    return {
      version: 1,
      scroll: captureEditorResumeScroll(root),
      ...(selection ? { selection } : {}),
    }
  })
}

export function restoreEditorResume(
  editor: LexicalEditor,
  saved: EditorResumeState,
  options: { selection?: boolean; scroll?: boolean } = {},
): void {
  const root = editor.getRootElement()
  if (!root) {
    return
  }
  const focused = root.contains(root.ownerDocument.activeElement)
  if (saved.selection && options.selection !== false) {
    editor.update(
      () => {
        const relative = saved.selection?.relative && resolveRelativeResumeSelection(editor, saved.selection.relative)
        const relativeAnchor = relative?.anchorKey && $getNodeByKey(relative.anchorKey)
        const relativeFocus = relative?.focusKey && $getNodeByKey(relative.focusKey)
        const anchor = relativeAnchor
          ? clampPoint(relativeAnchor, relative.anchorOffset)
          : resolvePoint(saved.selection!.anchor)
        const focus = relativeFocus
          ? clampPoint(relativeFocus, relative.focusOffset)
          : resolvePoint(saved.selection!.focus)
        if (anchor && focus) {
          const selection = $createRangeSelection()
          selection.anchor.set(anchor.key, anchor.offset, anchor.type)
          selection.focus.set(focus.key, focus.offset, focus.type)
          $setSelection(selection)
        }
      },
      {
        discrete: true,
        tag: focused ? [SKIP_SCROLL_INTO_VIEW_TAG] : [SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG],
      },
    )
  }
  if (options.scroll !== false) {
    root.scrollTop = saved.scroll.rootTop
    root.scrollLeft = saved.scroll.rootLeft
    const outer = root.closest<HTMLElement>('.editor-scroller')
    if (outer) {
      outer.scrollTop = saved.scroll.outerTop
      outer.scrollLeft = saved.scroll.outerLeft
    }
  }
}

function validPoint(value: unknown): value is ResumePoint {
  const point = value as ResumePoint | null
  return Boolean(
    point &&
    (point.type === 'text' || point.type === 'element') &&
    Array.isArray(point.path) &&
    point.path.length <= 64 &&
    point.path.every((index) => Number.isSafeInteger(index) && index >= 0 && index <= 1_000_000) &&
    Number.isSafeInteger(point.offset) &&
    point.offset >= 0 &&
    point.offset <= 10_000_000,
  )
}

export function parseEditorResume(raw: string | null): EditorResumeState | undefined {
  if (!raw || raw.length > 12000) {
    return
  }
  try {
    const value = JSON.parse(raw) as EditorResumeState
    if (
      value.version !== 1 ||
      !value.scroll ||
      !['rootTop', 'rootLeft', 'outerTop', 'outerLeft'].every(
        (field) =>
          Number.isFinite(value.scroll[field as keyof typeof value.scroll]) &&
          value.scroll[field as keyof typeof value.scroll] >= 0 &&
          value.scroll[field as keyof typeof value.scroll] <= 100_000_000,
      )
    ) {
      return
    }
    if (
      value.lastInteractionAt !== undefined &&
      (!Number.isSafeInteger(value.lastInteractionAt) || value.lastInteractionAt < 0)
    ) {
      return
    }
    if (value.selection && (!validPoint(value.selection.anchor) || !validPoint(value.selection.focus))) {
      return
    }
    if (
      value.selection?.relative &&
      !['anchor', 'focus'].every(
        (field) =>
          typeof value.selection!.relative![field as 'anchor' | 'focus'] === 'string' &&
          value.selection!.relative![field as 'anchor' | 'focus'].length <= 2048,
      )
    ) {
      return
    }
    // Whitelist metadata; arbitrary supplied fields never become a view snapshot.
    const point = (input: ResumePoint): ResumePoint => ({ path: input.path, offset: input.offset, type: input.type })
    return {
      version: 1,
      ...(value.lastInteractionAt !== undefined ? { lastInteractionAt: value.lastInteractionAt } : {}),
      scroll: {
        rootTop: value.scroll.rootTop,
        rootLeft: value.scroll.rootLeft,
        outerTop: value.scroll.outerTop,
        outerLeft: value.scroll.outerLeft,
      },
      ...(value.selection
        ? {
            selection: {
              anchor: point(value.selection.anchor),
              focus: point(value.selection.focus),
              ...(value.selection.relative
                ? { relative: { anchor: value.selection.relative.anchor, focus: value.selection.relative.focus } }
                : {}),
            },
          }
        : {}),
    }
  } catch {
    return
  }
}
