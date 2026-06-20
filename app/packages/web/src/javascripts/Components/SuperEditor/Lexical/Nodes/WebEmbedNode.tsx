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
import Icon from '@/Components/Icon/Icon'
import { sanitizeWebEmbedUrl } from './sanitizeWebEmbedUrl'

export type WebEmbedData = {
  url: string
  /** Bounded iframe height in px. Defaults to DEFAULT_HEIGHT. */
  height?: number
}

const DEFAULT_HEIGHT = 480
const MIN_HEIGHT = 160
const MAX_HEIGHT = 1200

const DEFAULT_WEB_EMBED: WebEmbedData = { url: '' }

/**
 * Plain-language warning shown on the click-to-load placeholder card. Embedding
 * an arbitrary website is meaningfully riskier than the YouTube/Vimeo embed, so
 * we surface the tradeoffs up front and require an explicit opt-in to load.
 */
const RISK_WARNING =
  'Embedding an external website can expose you to tracking and third-party scripts. ' +
  'The page is loaded directly from that site, so it is not end-to-end encrypted or protected by Standard Notes. ' +
  'Many sites block embedding (via X-Frame-Options or Content-Security-Policy), so it may not load. ' +
  'Only embed websites you trust.'

function clampHeight(height: number | undefined): number {
  if (!height || Number.isNaN(height)) {
    return DEFAULT_HEIGHT
  }
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)))
}

function WebEmbedComponent({ data, nodeKey }: { data: WebEmbedData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const safeUrl = sanitizeWebEmbedUrl(data.url)
  const [draft, setDraft] = useState(data.url)
  const [editing, setEditing] = useState(!safeUrl)
  // Default to click-to-load for safety: never auto-load the iframe.
  const [loaded, setLoaded] = useState(false)

  const height = clampHeight(data.height)

  const commit = useCallback(
    (url: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isWebEmbedNode(node)) {
          node.setData({ url, height: node.getData().height })
        }
      })
      setEditing(false)
      setLoaded(false)
    },
    [editor, nodeKey],
  )

  if (editing) {
    return (
      <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-web-embed-block="true">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
          <span className="font-semibold">Embed website</span>
        </div>
        <div className="p-2">
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
            placeholder="Paste a website URL (https://…) to embed"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(draft)
              }
            }}
            autoFocus
          />
          {draft.trim() && !sanitizeWebEmbedUrl(draft) ? (
            <div className="mt-1 text-xs text-danger">Enter a valid http(s) website URL.</div>
          ) : null}
          <button
            type="button"
            className="mt-2 rounded bg-info px-3 py-1 text-sm text-info-contrast disabled:opacity-50"
            disabled={!sanitizeWebEmbedUrl(draft)}
            onClick={() => commit(draft)}
          >
            Add website
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-web-embed-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="flex min-w-0 items-center font-semibold">
          <Icon type="window" className="mr-1.5 flex-shrink-0" />
          <span className="truncate">{safeUrl || 'Embed website'}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center rounded px-2 py-0.5 hover:bg-contrast"
              title="Open in a new tab"
            >
              <Icon type="open-in" className="mr-1" />
              Open
            </a>
          ) : null}
          <button type="button" className="rounded px-2 py-0.5 hover:bg-contrast" onClick={() => setEditing(true)}>
            Edit
          </button>
        </span>
      </div>

      {!safeUrl ? (
        <div className="p-2 text-sm text-danger">Enter a valid http(s) website URL to embed.</div>
      ) : !loaded ? (
        /* Risk-alert placeholder card: shown FIRST instead of an auto-loaded
           iframe. The user must explicitly opt in to loading external content. */
        <div className="p-3">
          <div className="flex items-start gap-2 rounded border border-warning bg-contrast p-2 text-sm text-foreground">
            <Icon type="warning" className="mt-0.5 flex-shrink-0 text-warning" />
            <div>
              <div className="font-semibold">Load external website?</div>
              <p className="mt-1 break-words text-passive-0">{RISK_WARNING}</p>
              <p className="mt-1 break-all text-xs text-passive-1">{safeUrl}</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded bg-info px-3 py-1 text-sm text-info-contrast"
              onClick={() => setLoaded(true)}
            >
              Load page
            </button>
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-border px-3 py-1 text-sm hover:bg-contrast"
            >
              Open in a new tab instead
            </a>
          </div>
        </div>
      ) : (
        <div className="p-2">
          {/* Bounded, responsive container: full width, capped height, no overflow. */}
          <div className="w-full max-w-full overflow-hidden rounded border border-border" style={{ height }}>
            {/* Hardened iframe: least-permissive sandbox that still renders most
                pages. We keep allow-same-origin because dropping it breaks many
                sites' own scripts/styles, but we drop allow-top-navigation,
                allow-modals, and allow-downloads. no-referrer avoids leaking the
                note URL; lazy loading avoids fetching until scrolled into view. */}
            <iframe
              title={`Embedded website: ${safeUrl}`}
              src={safeUrl}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
          {/* We cannot reliably detect X-Frame-Options / CSP frame-ancestors
              denial from script, so we always surface this fallback hint. */}
          <p className="mt-1 text-xs text-passive-1">
            If the page is blank, the site blocks embedding —{' '}
            <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline">
              open it in a new tab
            </a>
            .
          </p>
        </div>
      )}
    </div>
  )
}

export type SerializedWebEmbedNode = Spread<{ data: WebEmbedData }, SerializedLexicalNode>

export class WebEmbedNode extends DecoratorNode<React.JSX.Element> {
  __data: WebEmbedData

  static getType(): string {
    return 'web-embed'
  }

  static clone(node: WebEmbedNode): WebEmbedNode {
    return new WebEmbedNode(node.__data, node.__key)
  }

  constructor(data: WebEmbedData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedWebEmbedNode): WebEmbedNode {
    const data = serializedNode.data || DEFAULT_WEB_EMBED
    return $createWebEmbedNode({
      url: typeof data.url === 'string' ? data.url : '',
      height: clampHeight(data.height),
    })
  }

  exportJSON(): SerializedWebEmbedNode {
    return {
      type: 'web-embed',
      version: 1,
      data: { url: this.__data.url ?? '', height: clampHeight(this.__data.height) },
    }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): WebEmbedData {
    return this.getLatest().__data
  }

  setData(data: WebEmbedData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.url ?? ''
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <WebEmbedComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createWebEmbedNode(data: WebEmbedData = DEFAULT_WEB_EMBED): WebEmbedNode {
  return new WebEmbedNode({ url: data.url ?? '', height: clampHeight(data.height) })
}

export function $isWebEmbedNode(node: LexicalNode | null | undefined): node is WebEmbedNode {
  return node instanceof WebEmbedNode
}
