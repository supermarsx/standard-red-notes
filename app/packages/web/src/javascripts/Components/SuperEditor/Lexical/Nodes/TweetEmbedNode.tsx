import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { sanitizeTweetUrl } from './sanitizeTweetUrl'

export type TweetEmbedData = { url: string }

const DEFAULT_TWEET_EMBED: TweetEmbedData = { url: '' }

const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js'

type TwttrWidgets = {
  widgets?: { load?: (element?: HTMLElement) => void }
}

declare global {
  interface Window {
    twttr?: TwttrWidgets
  }
}

/**
 * Load platform.twitter.com/widgets.js exactly once for the whole document and
 * resolve when window.twttr.widgets is available. Subsequent callers reuse the
 * same promise. Rejects (caught by callers) if the script fails to load so we
 * can fall back to the raw link.
 */
let widgetsPromise: Promise<TwttrWidgets> | null = null

function loadTwitterWidgets(): Promise<TwttrWidgets> {
  if (widgetsPromise) {
    return widgetsPromise
  }

  widgetsPromise = new Promise<TwttrWidgets>((resolve, reject) => {
    if (window.twttr?.widgets?.load) {
      resolve(window.twttr)
      return
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGETS_SRC}"]`)
    const onReady = () => {
      if (window.twttr?.widgets?.load) {
        resolve(window.twttr)
      } else {
        reject(new Error('Twitter widgets failed to initialize'))
      }
    }

    if (existing) {
      existing.addEventListener('load', onReady, { once: true })
      existing.addEventListener('error', () => reject(new Error('Twitter widgets failed to load')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = WIDGETS_SRC
    script.async = true
    script.charset = 'utf-8'
    script.addEventListener('load', onReady, { once: true })
    script.addEventListener('error', () => reject(new Error('Twitter widgets failed to load')), { once: true })
    document.head.appendChild(script)
  })

  return widgetsPromise
}

function TweetEmbedComponent({ data, nodeKey }: { data: TweetEmbedData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const safeUrl = sanitizeTweetUrl(data.url)
  const [draft, setDraft] = useState(data.url)
  const [editing, setEditing] = useState(!safeUrl)
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const commit = useCallback(
    (url: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isTweetEmbedNode(node)) {
          node.setData({ url })
        }
      })
      setEditing(false)
      setFailed(false)
    },
    [editor, nodeKey],
  )

  // Hydrate the embed once we have a trusted URL and are not in edit mode. The
  // <blockquote class="twitter-tweet"> is rendered by React below; here we just
  // ask widgets.js to upgrade it in place, scoped to this decorator's DOM node.
  useEffect(() => {
    if (!safeUrl || editing) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    let cancelled = false
    setFailed(false)
    loadTwitterWidgets()
      .then((twttr) => {
        if (!cancelled) {
          twttr.widgets?.load?.(container)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [safeUrl, editing])

  if (editing) {
    return (
      <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-tweet-embed-block="true">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
          <span className="font-semibold">Tweet / X post</span>
        </div>
        <div className="p-2">
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
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
            <div className="mt-1 text-xs text-danger">Enter a valid twitter.com or x.com status URL.</div>
          ) : null}
          <button
            type="button"
            className="mt-2 rounded bg-info px-3 py-1 text-sm text-info-contrast disabled:opacity-50"
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
    <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-tweet-embed-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Tweet / X post</span>
        <button type="button" className="rounded px-2 py-0.5 hover:bg-contrast" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      {!safeUrl ? (
        <div className="p-2 text-sm text-danger">Enter a valid twitter.com or x.com status URL.</div>
      ) : (
        <div className="p-2" ref={containerRef}>
          {/* widgets.js upgrades this blockquote in place. If the script fails
              to load, the blockquote degrades to a plain link to the post. */}
          <blockquote className="twitter-tweet">
            <a href={safeUrl} target="_blank" rel="noopener noreferrer">
              {safeUrl}
            </a>
          </blockquote>
          {failed ? (
            <p className="mt-1 text-xs text-passive-1">
              Could not load the embedded post.{' '}
              <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline">
                Open it on X
              </a>
              .
            </p>
          ) : null}
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
