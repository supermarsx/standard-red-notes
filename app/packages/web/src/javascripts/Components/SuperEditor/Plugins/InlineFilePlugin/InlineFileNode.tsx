import { DecoratorBlockNode, SerializedDecoratorBlockNode } from '@lexical/react/LexicalDecoratorBlockNode'
import React from 'react'
import {
  DOMExportOutput,
  EditorConfig,
  ElementFormatType,
  LexicalEditor,
  LexicalNode,
  LexicalUpdateJSON,
  NodeKey,
  Spread,
} from 'lexical'
import InlineFileComponent from './InlineFileComponent'
import { ImageFloat } from '../ImageTools/ImageToolsTypes'
import { hasCompatibleInlineImageSource, resolvePreviewKind } from '@/Components/FilePreview/isFilePreviewable'

type SerializedInlineFileNode = Spread<
  {
    fileName: string | undefined
    mimeType: string
    src: string
    width?: number
    caption?: string
    float?: ImageFloat
  },
  SerializedDecoratorBlockNode
>

export class InlineFileNode extends DecoratorBlockNode {
  __fileName: string | undefined
  __mimeType: string
  __src: string
  __width: number | undefined
  __caption: string | undefined
  __float: ImageFloat

  static getType(): string {
    return 'inline-file'
  }

  constructor(
    src: string,
    mimeType: string,
    fileName: string | undefined,
    format?: ElementFormatType,
    key?: NodeKey,
    width?: number,
    caption?: string,
    float?: ImageFloat,
  ) {
    super(format, key)
    this.__src = src
    this.__mimeType = mimeType
    this.__fileName = fileName
    this.__width = width
    this.__caption = caption
    this.__float = float || 'none'
  }

  static clone(node: InlineFileNode): InlineFileNode {
    return new InlineFileNode(
      node.__src,
      node.__mimeType,
      node.__fileName,
      node.__format,
      node.__key,
      node.__width,
      node.__caption,
      node.__float,
    )
  }

  static importJSON(serializedNode: SerializedInlineFileNode): InlineFileNode {
    const node = $createInlineFileNode(
      serializedNode.src,
      serializedNode.mimeType,
      serializedNode.fileName,
    ).updateFromJSON(serializedNode)
    return node
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedInlineFileNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setWidth(serializedNode.width)
      .setCaption(serializedNode.caption)
      .setFloat(serializedNode.float ?? 'none')
  }

  exportJSON(): SerializedInlineFileNode {
    return {
      ...super.exportJSON(),
      src: this.__src,
      mimeType: this.__mimeType,
      fileName: this.__fileName,
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

  static importDOM(): null {
    // HTML attributes are forgeable and may contain active or remote sources.
    // Lexical JSON remains the trusted persistence/internal-clipboard channel.
    return null
  }

  exportDOM(): DOMExportOutput {
    const resolvedKind = resolvePreviewKind({ mimeType: this.__mimeType, name: this.__fileName })
    const previewKind =
      resolvedKind === 'image' &&
      !isSafeInlineImage({ mimeType: this.__mimeType, fileName: this.__fileName, src: this.__src })
        ? 'unsupported'
        : resolvedKind
    if (previewKind === 'image') {
      const img = document.createElement('img')
      img.setAttribute('src', this.__src)
      img.setAttribute('data-mime-type', this.__mimeType)
      img.setAttribute('data-file-name', this.__fileName || '')
      return { element: img }
    } else if (previewKind === 'audio') {
      const audio = document.createElement('audio')
      audio.setAttribute('controls', '')
      audio.setAttribute('data-file-name', this.__fileName || '')
      const source = document.createElement('source')
      source.setAttribute('src', this.__src)
      source.setAttribute('type', this.__mimeType)
      audio.appendChild(source)
      return { element: audio }
    } else if (previewKind === 'video') {
      const video = document.createElement('video')
      video.setAttribute('controls', '')
      video.setAttribute('data-file-name', this.__fileName || '')
      const source = document.createElement('source')
      source.setAttribute('src', this.__src)
      source.setAttribute('type', this.__mimeType)
      video.appendChild(source)
      return { element: video }
    }
    // Generic files are exported as inert metadata. <object> would hand HTML,
    // SVG, or another active payload to the browser and could also be mistaken
    // for an image when the DOM is imported again.
    const file = document.createElement('span')
    file.setAttribute('data-lexical-inline-file', 'true')
    file.setAttribute('data-file-source', this.__src)
    file.setAttribute('data-mime-type', this.__mimeType)
    file.setAttribute('data-file-name', this.__fileName || '')
    file.textContent = `[File: ${this.__fileName || 'attachment'}]`
    return { element: file }
  }

  getTextContent(): string {
    const isImage = isSafeInlineImage({ mimeType: this.__mimeType, fileName: this.__fileName, src: this.__src })
    return `${isImage ? '!' : ''}[${this.__fileName}](${this.__src})`
  }

  decorate(_editor: LexicalEditor, config: EditorConfig): React.JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {}
    const className = {
      base: embedBlockTheme.base || '',
      focus: embedBlockTheme.focus || '',
    }

    return (
      <InlineFileComponent
        className={className}
        format={this.__format}
        setFormat={this.setFormat.bind(this)}
        node={this}
        nodeKey={this.getKey()}
        src={this.__src}
        mimeType={this.__mimeType}
        fileName={this.__fileName}
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

export function $isInlineFileNode(node: InlineFileNode | LexicalNode | null | undefined): node is InlineFileNode {
  return node instanceof InlineFileNode
}

export function $createInlineFileNode(src: string, mimeType: string, fileName: string | undefined): InlineFileNode {
  return new InlineFileNode(src, mimeType || 'application/octet-stream', fileName)
}

export function isSafeInlineImage(file: { mimeType: string; fileName: string | undefined; src?: string }): boolean {
  const metadata = { mimeType: file.mimeType, name: file.fileName }
  return file.src === undefined
    ? resolvePreviewKind(metadata) === 'image'
    : hasCompatibleInlineImageSource(metadata, file.src)
}
