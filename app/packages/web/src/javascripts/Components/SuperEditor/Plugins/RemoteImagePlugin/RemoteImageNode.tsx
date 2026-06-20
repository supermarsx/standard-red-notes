import { DecoratorBlockNode, SerializedDecoratorBlockNode } from '@lexical/react/LexicalDecoratorBlockNode'
import React from 'react'
import {
  DOMConversionMap,
  DOMExportOutput,
  EditorConfig,
  ElementFormatType,
  LexicalEditor,
  LexicalNode,
  LexicalUpdateJSON,
  NodeKey,
  Spread,
} from 'lexical'
import RemoteImageComponent from './RemoteImageComponent'
import { ImageFloat } from '../ImageTools/ImageToolsTypes'

type SerializedRemoteImageNode = Spread<
  {
    alt: string | undefined
    src: string
    width?: number
    caption?: string
    float?: ImageFloat
  },
  SerializedDecoratorBlockNode
>

export class RemoteImageNode extends DecoratorBlockNode {
  __alt: string | undefined
  __src: string
  __width: number | undefined
  __caption: string | undefined
  __float: ImageFloat

  static getType(): string {
    return 'unencrypted-image'
  }

  constructor(
    src: string,
    alt?: string,
    format?: ElementFormatType,
    key?: NodeKey,
    width?: number,
    caption?: string,
    float?: ImageFloat,
  ) {
    super(format, key)
    this.__src = src
    this.__alt = alt
    this.__width = width
    this.__caption = caption
    this.__float = float || 'none'
  }

  static clone(node: RemoteImageNode): RemoteImageNode {
    return new RemoteImageNode(
      node.__src,
      node.__alt,
      node.__format,
      node.__key,
      node.__width,
      node.__caption,
      node.__float,
    )
  }

  static importJSON(serializedNode: SerializedRemoteImageNode): RemoteImageNode {
    return $createRemoteImageNode(serializedNode.src, serializedNode.alt).updateFromJSON(serializedNode)
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedRemoteImageNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setWidth(serializedNode.width)
      .setCaption(serializedNode.caption)
      .setFloat(serializedNode.float ?? 'none')
  }

  exportJSON(): SerializedRemoteImageNode {
    return {
      ...super.exportJSON(),
      src: this.__src,
      alt: this.__alt,
      width: this.__width,
      caption: this.__caption,
      float: this.__float,
    }
  }

  setWidth(width: number | undefined): this {
    const self = this.getWritable()
    self.__width = width
    return self
  }

  setCaption(caption: string | undefined): this {
    const self = this.getWritable()
    self.__caption = caption
    return self
  }

  setFloat(float: ImageFloat): this {
    const self = this.getWritable()
    self.__float = float
    return self
  }

  static importDOM(): DOMConversionMap<HTMLDivElement> | null {
    return {
      img: (domNode: HTMLDivElement) => {
        if (domNode.tagName !== 'IMG') {
          return null
        }
        return {
          conversion: () => {
            if (!(domNode instanceof HTMLImageElement)) {
              return null
            }
            return {
              node: $createRemoteImageNode(domNode.currentSrc || domNode.src, domNode.alt),
            }
          },
          priority: 2,
        }
      },
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('img')
    if (this.__alt) {
      element.setAttribute('alt', this.__alt)
    }
    element.setAttribute('src', this.__src)
    return { element }
  }

  override getTextContent(): string {
    return `![${this.__alt || 'image'}](${this.__src})`
  }

  decorate(_editor: LexicalEditor, config: EditorConfig): React.JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {}
    const className = {
      base: embedBlockTheme.base || '',
      focus: embedBlockTheme.focus || '',
    }

    return (
      <RemoteImageComponent
        className={className}
        format={this.__format}
        setFormat={this.setFormat.bind(this)}
        nodeKey={this.getKey()}
        node={this}
        src={this.__src}
        alt={this.__alt}
        width={this.__width}
        setWidth={this.setWidth.bind(this)}
        caption={this.__caption}
        setCaption={this.setCaption.bind(this)}
        float={this.__float}
        setFloat={this.setFloat.bind(this)}
      />
    )
  }
}

export function $isRemoteImageNode(node: RemoteImageNode | LexicalNode | null | undefined): node is RemoteImageNode {
  return node instanceof RemoteImageNode
}

export function $createRemoteImageNode(src: string, alt?: string): RemoteImageNode {
  return new RemoteImageNode(src, alt)
}
