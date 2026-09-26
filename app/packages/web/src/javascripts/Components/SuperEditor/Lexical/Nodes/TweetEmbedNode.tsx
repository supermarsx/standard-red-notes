import * as React from 'react'
import { useCallback, useState } from 'react'
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
import { parseTweetUrl, sanitizeTweetUrl } from './sanitizeTweetUrl'

export type TweetEmbedData = { url: string }

const DEFAULT_TWEET_EMBED: TweetEmbedData = { url: '' }

/**
 * WHY THIS BLOCK DOES NOT RENDER THE REAL POST.
 *
 * It used to load platform.twitter.com/widgets.js and let X upgrade a blockquote
 * in place. Two independent reasons that is gone:
 *
 *  1. It never worked here. The app shell is served with `script-src 'self'
 *     'wasm-unsafe-eval' 'sha256-<bootstrap>'`, so the appended third-party script
 *     was refused and never requested — the post silently stayed a bare link from
 *     2026-07-03, the commit that introduced the policy, onward.
 *  2. Fixing it by permitting that host would be worse than the missing feature.
 *     A CSP governs the whole document, and this script was appended to the TOP
 *     document — so permitting the host would let X's script run beside decrypted
 *     note content, localStorage and IndexedDB. And because the widget then loads
 *     its own subresources, the allowlist could only be found by loosening until
 *     it worked, which is not a boundary.
 *
 * There is also a privacy reason to prefer this even where it would work: fetching
 * the post means telling X the reader's address and the time EVERY time the note
 * is opened, and by timing, which note they are in. For an end-to-end encrypted
 * notes app that is a leak the encryption does not cover. So the block renders a
 * reference from the URL already in the note, contacts nobody, and keeps a plain
 * link out for the reader who wants the original.
 */

function TweetEmbedComponent({ data, nodeKey }: { data: TweetEmbedData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const reference = parseTweetUrl(data.url)
  const safeUrl = reference?.url ?? ''
  const [draft, setDraft] = useState(data.url)
  const [editing, setEditing] = useState(!safeUrl)

  const commit = useCallback(
    (url: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isTweetEmbedNode(node)) {
          node.setData({ url })
        }
      })
      setEditing(false)
    },
    [editor, nodeKey],
  )

  if (editing) {
    return (
      <div
        className="border-border bg-default my-2 w-full max-w-full rounded border"
        data-tweet-embed-block="true"
        data-super-widget-layout="compact"
      >
        <div className="border-border text-passive-1 flex items-center justify-between border-b px-2 py-1 text-xs">
          <span className="font-semibold">Tweet / X post</span>
        </div>
        <div className="p-2">
          <input
            className="border-border bg-default text-foreground focus:border-info w-full rounded border px-2 py-1 text-sm outline-none"
            placeholder="Paste a tweet / X post URL (https://x.com/…/status/…)"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(draft)
              }
            }}
            autoFocus
          />
          {draft.trim() && !sanitizeTweetUrl(draft) ? (
            <div className="text-danger mt-1 text-xs" data-srn-print-exclude="true">
              Enter a valid twitter.com or x.com status URL.
            </div>
          ) : null}
          <button
            type="button"
            className="bg-info text-info-contrast mt-2 rounded px-3 py-1 text-sm disabled:opacity-50"
            disabled={!sanitizeTweetUrl(draft)}
            onClick={() => commit(draft)}
          >
            Embed post
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="border-border bg-default my-2 w-full max-w-full rounded border"
      data-tweet-embed-block="true"
      data-super-widget-layout="compact"
    >
      <div className="border-border text-passive-1 flex items-center justify-between border-b px-2 py-1 text-xs">
        <span className="font-semibold">Tweet / X post</span>
        <button type="button" className="hover:bg-contrast rounded px-2 py-0.5" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      {!reference ? (
        <div className="text-danger p-2 text-sm" data-srn-print-exclude="true">
          Enter a valid twitter.com or x.com status URL.
        </div>
      ) : (
        /* A reference built entirely from the URL in the note. Nothing here
           fetches the post, so opening a note never tells X that it was read. */
        <div className="p-2">
          <blockquote className="border-info m-0 border-l-2 pl-3">
            <span className="text-foreground block text-sm font-semibold">@{reference.handle}</span>
            <span className="text-passive-1 block text-xs">Post {reference.statusId} on X</span>
            <a
              href={reference.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info mt-1 inline-block text-sm underline"
            >
              Open on X
            </a>
          </blockquote>
          <p className="text-passive-1 mt-1 text-xs" data-srn-print-exclude="true">
            Shown as a link on purpose: rendering the post would require loading X&apos;s script, which would tell X
            each time you open this note.
          </p>
        </div>
      )}
    </div>
  )
}

export type SerializedTweetEmbedNode = Spread<{ data: TweetEmbedData }, SerializedLexicalNode>

export class TweetEmbedNode extends DecoratorNode<React.JSX.Element> {
  __data: TweetEmbedData

  static getType(): string {
    return 'tweet-embed'
  }

  static clone(node: TweetEmbedNode): TweetEmbedNode {
    return new TweetEmbedNode(node.__data, node.__key)
  }

  constructor(data: TweetEmbedData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedTweetEmbedNode): TweetEmbedNode {
    const data = serializedNode.data || DEFAULT_TWEET_EMBED
    return $createTweetEmbedNode({ url: typeof data.url === 'string' ? data.url : '' })
  }

  exportJSON(): SerializedTweetEmbedNode {
    return { type: 'tweet-embed', version: 1, data: { url: this.__data.url ?? '' } }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): TweetEmbedData {
    return this.getLatest().__data
  }

  setData(data: TweetEmbedData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.url ?? ''
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TweetEmbedComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createTweetEmbedNode(data: TweetEmbedData = DEFAULT_TWEET_EMBED): TweetEmbedNode {
  return new TweetEmbedNode({ url: data.url ?? '' })
}

export function $isTweetEmbedNode(node: LexicalNode | null | undefined): node is TweetEmbedNode {
  return node instanceof TweetEmbedNode
}
