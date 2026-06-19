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

export type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'
export type CalloutData = { variant: CalloutVariant; text: string }

const DEFAULT_CALLOUT: CalloutData = { variant: 'info', text: '' }

const VARIANT_STYLES: Record<CalloutVariant, { border: string; bar: string; label: string }> = {
  info: { border: 'border-info', bar: 'bg-info', label: 'Info' },
  success: { border: 'border-success', bar: 'bg-success', label: 'Success' },
  warning: { border: 'border-warning', bar: 'bg-warning', label: 'Warning' },
  danger: { border: 'border-danger', bar: 'bg-danger', label: 'Warning' },
}

const VARIANTS: CalloutVariant[] = ['info', 'success', 'warning', 'danger']

function CalloutComponent({ data, nodeKey }: { data: CalloutData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (patch: Partial<CalloutData>) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isCalloutNode(node)) {
          node.setData({ ...node.getData(), ...patch })
        }
      })
    },
    [editor, nodeKey],
  )

  const style = VARIANT_STYLES[data.variant]

  return (
    <div className={`my-2 flex gap-2 rounded border-l-4 bg-contrast p-2 ${style.border}`} data-callout-block="true">
      <div className="flex flex-col items-center gap-1">
        {VARIANTS.map((variant) => (
          <button
            key={variant}
            type="button"
            title={variant}
            onClick={() => mutate({ variant })}
            className={`h-3 w-3 rounded-full ${VARIANT_STYLES[variant].bar} ${
              data.variant === variant ? 'ring-2 ring-offset-1 ring-offset-transparent' : 'opacity-50'
            }`}
          />
        ))}
      </div>
      <textarea
        key={`callout-${nodeKey}`}
        className="min-h-[2rem] w-full resize-none bg-transparent text-sm text-foreground outline-none"
        rows={Math.max(2, data.text.split('\n').length)}
        defaultValue={data.text}
        placeholder={`${style.label}…`}
        onBlur={(event) => mutate({ text: event.target.value })}
      />
    </div>
  )
}

export type SerializedCalloutNode = Spread<{ data: CalloutData }, SerializedLexicalNode>

export class CalloutNode extends DecoratorNode<React.JSX.Element> {
  __data: CalloutData

  static getType(): string {
    return 'callout'
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__data, node.__key)
  }

  constructor(data: CalloutData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedCalloutNode): CalloutNode {
    return $createCalloutNode(serializedNode.data)
  }

  exportJSON(): SerializedCalloutNode {
    return { type: 'callout', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): CalloutData {
    return this.getLatest().__data
  }

  setData(data: CalloutData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return `> [${this.__data.variant}] ${this.__data.text}`
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <CalloutComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createCalloutNode(data: CalloutData = DEFAULT_CALLOUT): CalloutNode {
  return new CalloutNode(data)
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode
}
