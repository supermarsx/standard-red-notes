import * as React from 'react'
import { useCallback } from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'

export const COMMENT_VERSION = 1

/**
 * Persisted data for a block-level comment / annotation.
 *
 * `author` is a v1 user-editable free-text label: the block's `onSelect` only
 * receives the editor (no app/auth context), so the logged-in user cannot be
 * auto-stamped here. v2 defers to auto-filling this from the authenticated user.
 * `createdAt` is stamped once at `$createCommentNode()` time and preserved across
 * JSON round-trips.
 */
export type CommentData = {
  version: number
  /** The comment body. */
  text: string
  /** Free-text author label (v1: user-editable; v2: auto-filled from account). */
  author: string
  /** Epoch ms the comment was created; preserved across round-trips. */
  createdAt: number
}

export const DEFAULT_COMMENT_DATA: CommentData = {
  version: COMMENT_VERSION,
  text: '',
  author: '',
  createdAt: 0,
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * Normalizes data from importJSON with backward-compatible defaults. Legacy or
 * malformed blobs (missing fields, a non-object `data`, a NaN timestamp) yield a
 * sensible comment rather than throwing. `text`/`author` are string-coerced;
 * `createdAt` is numeric-coerced and repaired to `Date.now()` when not finite;
 * `version` is always stamped. Never throws. Mirrors `ClockNode.normalize`.
 */
export function normalize(data: Partial<CommentData> | undefined | null): CommentData {
  if (data == null || typeof data !== 'object') {
    return { version: COMMENT_VERSION, text: '', author: '', createdAt: Date.now() }
  }
  const createdAtRaw = typeof data.createdAt === 'number' ? data.createdAt : Number(data.createdAt)
  const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : Date.now()
  return {
    version: COMMENT_VERSION,
    text: coerceString(data.text),
    author: coerceString(data.author),
    createdAt,
  }
}

/** Human-readable timestamp for the comment header. Empty for an invalid date. */
export function formatCommentTimestamp(createdAt: number): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleString()
}

/**
 * Pure, presentational comment view — no Lexical/hook dependencies, so it can be
 * rendered in a provider-free test (the mandatory "does it actually render"
 * guard). Mirrors Callout's Tailwind styling: an accented aside with an author
 * input + timestamp header and a comment textarea.
 */
export function CommentView({
  text,
  author,
  createdAt,
  onChangeText,
  onChangeAuthor,
}: {
  text: string
  author: string
  createdAt: number
  onChangeText: (value: string) => void
  onChangeAuthor: (value: string) => void
}): React.JSX.Element {
  return (
    <div
      className="border-info bg-contrast my-3 flex flex-col gap-1 rounded border-l-4 p-2"
      data-comment-block="true"
      data-super-widget-layout="content"
    >
      <div className="text-passive-1 flex items-center justify-between gap-2 text-xs">
        <input
          className="text-foreground min-w-0 flex-1 bg-transparent font-semibold outline-none"
          defaultValue={author}
          placeholder="Author"
          aria-label="Comment author"
          onBlur={(event) => onChangeAuthor(event.target.value)}
        />
        <time className="whitespace-nowrap" data-comment-timestamp="true">
          {formatCommentTimestamp(createdAt)}
        </time>
      </div>
      <textarea
        className="text-foreground min-h-[2rem] w-full resize-none bg-transparent text-sm outline-none"
        rows={Math.max(2, text.split('\n').length)}
        defaultValue={text}
        placeholder="Comment…"
        aria-label="Comment text"
        onBlur={(event) => onChangeText(event.target.value)}
      />
    </div>
  )
}

function CommentComponent({ data, nodeKey }: { data: CommentData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (patch: Partial<CommentData>) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isCommentNode(node)) {
          node.setData({ ...node.getData(), ...patch })
        }
      })
    },
    [editor, nodeKey],
  )

  return (
    <CommentView
      text={data.text}
      author={data.author}
      createdAt={data.createdAt}
      onChangeText={(text) => mutate({ text })}
      onChangeAuthor={(author) => mutate({ author })}
    />
  )
}

export type SerializedCommentNode = Spread<{ data: CommentData }, SerializedLexicalNode>

export class CommentNode extends DecoratorNode<React.JSX.Element> {
  __data: CommentData

  static getType(): string {
    return 'comment'
  }

  static clone(node: CommentNode): CommentNode {
    return new CommentNode(node.__data, node.__key)
  }

  constructor(data: CommentData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedCommentNode): CommentNode {
    return $createCommentNode(serializedNode.data)
  }

  exportJSON(): SerializedCommentNode {
    return { type: 'comment', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): CommentData {
    return this.getLatest().__data
  }

  setData(data: CommentData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    const author = this.__data.author.trim()
    return `[Comment${author ? ` — ${author}` : ''}] ${this.__data.text}`
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <CommentComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createCommentNode(data?: Partial<CommentData>): CommentNode {
  return new CommentNode(normalize(data ?? {}))
}

export function $isCommentNode(node: LexicalNode | null | undefined): node is CommentNode {
  return node instanceof CommentNode
}
