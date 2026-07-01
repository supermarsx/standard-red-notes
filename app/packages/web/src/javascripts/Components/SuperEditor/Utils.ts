import { $getRoot, $isElementNode, $isTextNode, EditorState, ElementNode, LexicalNode, TextNode } from 'lexical'

export function truncateString(string: string, limit: number) {
  if (string.length <= limit) {
    return string
  } else {
    return string.substring(0, limit) + '...'
  }
}

export interface FlushableDebounce<Args extends unknown[]> {
  /** Schedule a trailing call; repeated calls within the window coalesce to one. */
  (...args: Args): void
  /** Run any pending trailing call NOW (cancelling the timer). No-op if nothing pending. */
  flush: () => void
  /** Drop any pending trailing call WITHOUT running it. */
  cancel: () => void
  /**
   * Standard Red Notes (last-edit-loss fix): true iff a trailing call is currently
   * scheduled but has not yet run — i.e. an edit lives only in this debounce's timer
   * closure and is NOT yet dirty. Lifecycle safety gates (beforeunload warning,
   * note-switch flush) consult this to avoid silently dropping that edit.
   */
  hasPending: () => boolean
}

/**
 * Standard Red Notes (FIX 1): a trailing debounce whose pending call can be
 * FLUSHED on demand. The Super editor serializes the whole document
 * (JSON.stringify(editorState.toJSON())) on every change — O(doc-size) — which
 * froze typing on large (e.g. 500KB) notes. We debounce that serialize so rapid
 * typing serializes at most once per `waitMs`, and FLUSH the pending serialize on
 * blur/unmount so the latest content is always captured before save (no trailing
 * edit is lost). Always invokes with the args of the MOST RECENT call.
 */
export function createFlushableDebounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  waitMs: number,
): FlushableDebounce<Args> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: Args | null = null

  const invoke = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    if (pendingArgs === null) {
      return
    }
    const args = pendingArgs
    pendingArgs = null
    func(...args)
  }

  const debounced = ((...args: Args) => {
    pendingArgs = args
    if (timeout) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(invoke, waitMs)
  }) as FlushableDebounce<Args>

  debounced.flush = invoke
  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    pendingArgs = null
  }
  debounced.hasPending = () => pendingArgs !== null

  return debounced
}

/**
 * Standard Red Notes (FIX 1b): collect the first `limit` text nodes in document
 * order WITHOUT walking the entire node tree. The previous code did
 * `$getRoot().getAllTextNodes().slice(0, limit)`, which materializes every text
 * node in the document (O(node-count)) just to keep the first two — expensive on
 * a huge note and run on every change. This iterative DFS stops as soon as it has
 * collected `limit` text nodes.
 */
export function getFirstTextNodes(root: ElementNode, limit: number): TextNode[] {
  const result: TextNode[] = []
  if (limit <= 0) {
    return result
  }

  // DFS over children in document order using an explicit stack. We push a node's
  // children in reverse so they are visited left-to-right, and bail out the moment
  // we've gathered `limit` text nodes.
  const stack: LexicalNode[] = [...root.getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop() as LexicalNode
    if ($isTextNode(node)) {
      result.push(node)
      if (result.length >= limit) {
        return result
      }
    } else if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i])
      }
    }
  }

  return result
}

export function handleEditorChange(
  editorState: EditorState,
  previewLength?: number,
  onChange?: (value: string, previewText: string) => void,
) {
  const childrenNodes = getFirstTextNodes($getRoot(), 2)
  let previewText = ''
  childrenNodes.forEach((node, index) => {
    previewText += node.getTextContent()
    if (index !== childrenNodes.length - 1) {
      previewText += '\n'
    }
  })

  if (previewLength) {
    previewText = truncateString(previewText, previewLength)
  }

  try {
    const stringifiedEditorState = JSON.stringify(editorState.toJSON())
    onChange?.(stringifiedEditorState, previewText)
  } catch (error) {
    console.error(error)
    window.alert(
      `An invalid change was made inside the Super editor. Your change was not saved. Please report this error to the team: ${JSON.stringify(
        error,
      )}`,
    )
  }
}
