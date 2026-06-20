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
import { toEmbedUrl } from './toEmbedUrl'

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

  const embedUrl = data.url ? toEmbedUrl(data.url) : ''
  const isHttps = embedUrl.startsWith('https://') || embedUrl.startsWith('http://')

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
            placeholder="Paste a URL (YouTube, Vimeo, or any embeddable page)…"
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
      ) : isHttps ? (
        /* 16:9 responsive container so the video fills the width instead of
           rendering as a thin strip; the iframe stretches to fill it. */
        <div className="aspect-video w-full">
          {/* Safety tradeoff: the YouTube/Vimeo player needs scripts + same-origin
              (its embed shell) + presentation/popups (fullscreen, "watch on
              YouTube"). A stricter sandbox (e.g. dropping allow-scripts or
              allow-same-origin) blocks the player from loading/playing. */}
          <iframe
            title="Embedded content"
            src={embedUrl}
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className="p-2 text-sm text-danger">Enter a valid http(s) URL to embed.</div>
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
