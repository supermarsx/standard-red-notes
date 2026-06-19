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

export type EmbedData = { url: string }

const DEFAULT_EMBED: EmbedData = { url: '' }

// Normalize common share URLs to their embeddable form.
function toEmbedUrl(raw: string): string {
  const url = raw.trim()
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/)
  if (yt) {
    return `https://www.youtube.com/embed/${yt[1]}`
  }
  const vimeo = url.match(/vimeo\.com\/(\d+)/)
  if (vimeo) {
    return `https://player.vimeo.com/video/${vimeo[1]}`
  }
  return url
}

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
        <div className="aspect-video w-full">
          <iframe
            title="Embedded content"
            src={embedUrl}
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
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
