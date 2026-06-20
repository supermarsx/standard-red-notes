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
import { toTrustedEmbedUrl } from './toEmbedUrl'

export type EmbedData = { url: string }

const DEFAULT_EMBED: EmbedData = { url: '' }

function EmbedComponent({ data, nodeKey }: { data: EmbedData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [draft, setDraft] = useState(data.url)
  const [editing, setEditing] = useState(!data.url)

  const commit = useCallback(
    (url: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isEmbedNode(node)) {
          node.setData({ url })
        }
      })
      setEditing(false)
    },
    [editor, nodeKey],
  )

  // Only a recognized, trusted provider (YouTube / Vimeo) yields a non-null
  // embed URL. Arbitrary http(s) origins return null and are NEVER loaded in an
  // allow-same-origin iframe — see toEmbedUrl's security note.
  const embedUrl = data.url ? toTrustedEmbedUrl(data.url) : null
  const rawUrl = data.url.trim()
  // Only expose an "Open in new tab" link for http(s) URLs so we never render an
  // href for dangerous schemes (javascript:, data:, etc.).
  const safeRawHref = /^https?:\/\//i.test(rawUrl) ? rawUrl : null

  return (
    <div className="my-2 rounded border border-border bg-default" data-embed-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Embed</span>
        <button
          type="button"
          className="rounded px-2 py-0.5 hover:bg-contrast"
          onClick={() => (editing ? commit(draft) : setEditing(true))}
        >
          {editing ? 'Embed' : 'Edit'}
        </button>
      </div>
      {editing ? (
        <div className="p-2">
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
            placeholder="Paste a YouTube or Vimeo URL…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(draft)
              }
            }}
            autoFocus
          />
        </div>
      ) : embedUrl ? (
        /* 16:9 responsive container so the video fills the width instead of
           rendering as a thin strip; the iframe stretches to fill it. */
        <div className="aspect-video w-full">
          {/* `allow-same-origin` is only safe here because `embedUrl` is gated by
              toTrustedEmbedUrl: it is always a canonical YouTube/Vimeo embed
              origin, never an arbitrary attacker-chosen URL. The player needs
              scripts + same-origin (its embed shell) + presentation (fullscreen).
              We drop allow-popups, and add no-referrer to avoid leaking the note
              URL — matching the hardened WebEmbedNode iframe. */}
          <iframe
            title="Embedded content"
            src={embedUrl}
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : rawUrl ? (
        /* Unrecognized / unsupported URL. We deliberately do NOT load it in an
           allow-same-origin iframe (that would let an arbitrary origin run
           scripts in its own real origin). Show a safe card with the raw URL and
           an "Open in new tab" link, and point at the click-to-load website
           embed for arbitrary pages. */
        <div className="p-3 text-sm">
          <p className="text-foreground">
            This URL is not a supported video embed (YouTube or Vimeo).
          </p>
          <p className="mt-1 break-all text-xs text-passive-1">{rawUrl}</p>
          {safeRawHref ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href={safeRawHref}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border border-border px-3 py-1 text-sm hover:bg-contrast"
              >
                Open in a new tab
              </a>
            </div>
          ) : null}
          <p className="mt-2 text-xs text-passive-1">
            To embed an arbitrary web page, use the “Embed website” block, which loads only after you confirm.
          </p>
        </div>
      ) : (
        <div className="p-2 text-sm text-danger">Enter a YouTube or Vimeo URL to embed.</div>
      )}
    </div>
  )
}

export type SerializedEmbedNode = Spread<{ data: EmbedData }, SerializedLexicalNode>

export class EmbedNode extends DecoratorNode<React.JSX.Element> {
  __data: EmbedData

  static getType(): string {
    return 'embed'
  }

  static clone(node: EmbedNode): EmbedNode {
    return new EmbedNode(node.__data, node.__key)
  }

  constructor(data: EmbedData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedEmbedNode): EmbedNode {
    return $createEmbedNode(serializedNode.data)
  }

  exportJSON(): SerializedEmbedNode {
    return { type: 'embed', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): EmbedData {
    return this.getLatest().__data
  }

  setData(data: EmbedData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.url
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <EmbedComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createEmbedNode(data: EmbedData = DEFAULT_EMBED): EmbedNode {
  return new EmbedNode(data)
}

export function $isEmbedNode(node: LexicalNode | null | undefined): node is EmbedNode {
  return node instanceof EmbedNode
}
