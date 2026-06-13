import * as React from 'react'
import { lazy, Suspense } from 'react'
import {
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'

export interface ExcalidrawSceneData {
  elements: unknown[]
  appState: { viewBackgroundColor?: string }
  files: Record<string, unknown>
}

const EMPTY_SCENE: ExcalidrawSceneData = { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }

// Heavy (@excalidraw/excalidraw) component is lazy-loaded so it's code-split out
// of the main bundle and only fetched when a drawing is actually rendered.
const LazyExcalidraw = lazy(() => import('./ExcalidrawComponent'))

export type SerializedExcalidrawNode = Spread<{ data: string }, SerializedLexicalNode>

export class ExcalidrawNode extends DecoratorNode<React.JSX.Element> {
  /** Serialized JSON of the scene ({ elements, appState, files }). */
  __data: string

  static getType(): string {
    return 'excalidraw'
  }

  static clone(node: ExcalidrawNode): ExcalidrawNode {
    return new ExcalidrawNode(node.__data, node.__key)
  }

  constructor(data: string, key?: NodeKey) {
    super(key)
    this.__data = data || JSON.stringify(EMPTY_SCENE)
  }

  static importJSON(serializedNode: SerializedExcalidrawNode): ExcalidrawNode {
    return $createExcalidrawNode(serializedNode.data)
  }

  exportJSON(): SerializedExcalidrawNode {
    return {
      type: 'excalidraw',
      version: 1,
      data: this.__data,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div')
    element.setAttribute('data-lexical-excalidraw', 'true')
    element.setAttribute('data-scene', this.__data)
    return { element }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getSceneData(): ExcalidrawSceneData {
    try {
      return JSON.parse(this.getLatest().__data) as ExcalidrawSceneData
    } catch {
      return EMPTY_SCENE
    }
  }

  setData(scene: ExcalidrawSceneData): void {
    this.getWritable().__data = JSON.stringify(scene)
  }

  getTextContent(): string {
    return '[drawing]'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return (
      <Suspense fallback={<div className="my-2 p-4 text-sm text-passive-1">Loading drawing…</div>}>
        <LazyExcalidraw data={this.getSceneData()} nodeKey={this.getKey()} />
      </Suspense>
    )
  }
}

export function $createExcalidrawNode(data = JSON.stringify(EMPTY_SCENE)): ExcalidrawNode {
  return new ExcalidrawNode(data)
}

export function $isExcalidrawNode(node: LexicalNode | null | undefined): node is ExcalidrawNode {
  return node instanceof ExcalidrawNode
}
