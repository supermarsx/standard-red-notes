import * as React from 'react'
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

import { hasCompatibleInlineImageSource } from '@/Components/FilePreview/isFilePreviewable'
import { ImageFloat } from '../../Plugins/ImageTools/ImageToolsTypes'

/**
 * Standard Red Notes: the ONE node a public share link uses for an image the
 * note embedded, and for an attachment that could not come along.
 *
 *
 * WHY A NEW NODE RATHER THAN `inline-file`
 *
 * A share link renders with NO `WebApplication`: `App.tsx` early-returns into
 * the public viewer before the authed `ApplicationGroupView` ever mounts, so
 * there is no `<ApplicationProvider>` on the page. Every existing image-capable
 * node fails there, and fails invisibly:
 *
 *   - `FileNode` (`snfile`) calls `useApplication()` directly;
 *   - `InlineFileNode` calls it too, for its save-to-Files affordance;
 *   - `RemoteImageNode` calls it, and also goes through `usePreference`, which
 *     calls it again.
 *
 * `useApplication()` THROWS without a provider, so each of those is caught by
 * the viewer's decorator boundary and replaced by "this block could not be
 * displayed". Reusing one of them would have put the bytes in the envelope and
 * STILL shown the reader nothing — the exact failure this work exists to end.
 *
 * So this node is deliberately inert: no `useApplication`, no `usePreference`,
 * no composer hooks, no network, no state. It is a `<figure>` and an `<img>`.
 * It therefore also cannot throw, which matters on a page whose reader has no
 * other copy of the note.
 *
 *
 * WHY ONE NODE FOR BOTH STATES
 *
 * An image that is present and an attachment that is absent are the same
 * authoring decision seen from two sides, and the absent case is the one that
 * must never be silent: a reader who sees nothing cannot tell the note is
 * incomplete. Carrying both in one node means the placeholder is produced by
 * the same code path, in the same position in the document, with the same
 * `data-share-asset` hook — rather than being a separate thing that can be
 * forgotten.
 *
 *
 * WHAT IT WILL NOT RENDER
 *
 * `src` must be a `data:` URL whose declared media type matches `mimeType`, is
 * base64, and whose leading bytes carry a supported image signature — the same
 * `hasCompatibleInlineImageSource` gate the in-app editor applies. The check is
 * re-run HERE, at render, and not only where the node was built: the node is
 * reconstructed from an envelope the page just decrypted, so the render-time
 * check is the only one that runs on the bytes the reader actually received.
 * A `src` that fails it degrades to the placeholder; it never reaches `<img>`.
 */

/** Why an embedded attachment is not in the share. Mirrors `shareAssets.ts`. */
export type SharedImageOmissionReason =
  | 'not-found'
  | 'not-an-image'
  | 'too-large'
  | 'budget-exhausted'
  | 'download-failed'
  | 'content-mismatch'
  /** The envelope carried an `src` that failed the render-time image gate. */
  | 'unsafe-source'

export const SHARED_IMAGE_NODE_TYPE = 'shared-image'

/** The DOM attribute both states carry, so the reader's page is probeable. */
export const SHARED_IMAGE_DOM_ATTR = 'data-share-asset'

export type SerializedSharedImageNode = Spread<
  {
    /** A `data:` URL, or absent when the attachment could not be included. */
    src?: string
    mimeType?: string
    /** The attachment's display name. Shown in the placeholder sentence. */
    fileName?: string
    /** Present only on the placeholder side. */
    reason?: SharedImageOmissionReason
    /** The sentence to show when there is no image. Authored by `shareAssets`. */
    message?: string
    width?: number
    caption?: string
    float?: ImageFloat
  },
  SerializedLexicalNode
>

type ComponentProps = {
  src: string | undefined
  mimeType: string | undefined
  fileName: string | undefined
  reason: SharedImageOmissionReason | undefined
  message: string | undefined
  width: number | undefined
  caption: string | undefined
  float: ImageFloat
}

/**
 * True only for a source this node may put in an `<img>`.
 *
 * Exported so the share builder and this renderer agree by construction rather
 * than by two copies of the same rule drifting apart.
 *
 * THE `data:` PREFIX CHECK IS LOAD-BEARING and is not redundant with
 * `hasCompatibleInlineImageSource`. That helper validates the payload of a
 * `data:` URL and returns TRUE for every other scheme — it was written for the
 * editor, where a remote `src` is a legitimate thing a user typed. Here it is
 * not: a share envelope is decrypted from a row on a server, and an `<img>`
 * pointing at a remote host would fetch on the reader's behalf, handing a third
 * party the reader's IP and the fact that they opened this link. `file://`
 * and `javascript:` are refused for the same reason — never on the grounds
 * that the browser would probably refuse them anyway.
 *
 * A share image is always self-contained, so "must be a data URL" is both the
 * correct rule and the simplest one.
 */
export function isRenderableSharedImageSource(
  source: string | undefined,
  mimeType: string | undefined,
  fileName: string | undefined,
): boolean {
  if (typeof source !== 'string' || source.length === 0 || typeof mimeType !== 'string') {
    return false
  }
  if (!source.trimStart().toLowerCase().startsWith('data:')) {
    return false
  }
  return hasCompatibleInlineImageSource({ mimeType, name: fileName }, source)
}

function floatStyle(float: ImageFloat): React.CSSProperties {
  if (float === 'left') {
    return { float: 'left', marginRight: '1rem', marginBottom: '0.5rem' }
  }
  if (float === 'right') {
    return { float: 'right', marginLeft: '1rem', marginBottom: '0.5rem' }
  }
  return {}
}

function SharedImageComponent({
  src,
  mimeType,
  fileName,
  reason,
  message,
  width,
  caption,
  float,
}: ComponentProps): React.JSX.Element {
  const renderable = isRenderableSharedImageSource(src, mimeType, fileName)

  if (!renderable) {
    // The placeholder is VISIBLE on purpose, and names the file. A reader who
    // is shown nothing has no way to know the note is incomplete; a reader who
    // is shown this can ask the author for the file.
    return (
      <div
        {...{ [SHARED_IMAGE_DOM_ATTR]: reason ?? 'unsafe-source' }}
        data-share-asset-name={fileName ?? ''}
        className="border-border text-passive-0 my-2 rounded border border-dashed px-3 py-2 text-sm italic"
      >
        {message ?? `[${fileName ? `“${fileName}”` : 'An attachment'} is not included in this share link.]`}
      </div>
    )
  }

  return (
    <figure
      {...{ [SHARED_IMAGE_DOM_ATTR]: 'image' }}
      data-share-asset-name={fileName ?? ''}
      className="my-2"
      style={floatStyle(float)}
    >
      <img
        src={src}
        alt={caption || fileName || ''}
        style={{ maxWidth: '100%', width: width === undefined ? undefined : `${width}px`, height: 'auto' }}
      />
      {caption ? <figcaption className="text-passive-0 mt-1 text-sm">{caption}</figcaption> : null}
    </figure>
  )
}

export class SharedImageNode extends DecoratorNode<React.JSX.Element> {
  __src: string | undefined
  __mimeType: string | undefined
  __fileName: string | undefined
  __reason: SharedImageOmissionReason | undefined
  __message: string | undefined
  __width: number | undefined
  __caption: string | undefined
  __float: ImageFloat

  static getType(): string {
    return SHARED_IMAGE_NODE_TYPE
  }

  constructor(
    props: {
      src?: string
      mimeType?: string
      fileName?: string
      reason?: SharedImageOmissionReason
      message?: string
      width?: number
      caption?: string
      float?: ImageFloat
    } = {},
    key?: NodeKey,
  ) {
    super(key)
    this.__src = props.src
    this.__mimeType = props.mimeType
    this.__fileName = props.fileName
    this.__reason = props.reason
    this.__message = props.message
    this.__width = props.width
    this.__caption = props.caption
    this.__float = props.float ?? 'none'
  }

  static clone(node: SharedImageNode): SharedImageNode {
    return new SharedImageNode(
      {
        src: node.__src,
        mimeType: node.__mimeType,
        fileName: node.__fileName,
        reason: node.__reason,
        message: node.__message,
        width: node.__width,
        caption: node.__caption,
        float: node.__float,
      },
      node.__key,
    )
  }

  static importJSON(serializedNode: SerializedSharedImageNode): SharedImageNode {
    return new SharedImageNode({
      src: typeof serializedNode.src === 'string' ? serializedNode.src : undefined,
      mimeType: typeof serializedNode.mimeType === 'string' ? serializedNode.mimeType : undefined,
      fileName: typeof serializedNode.fileName === 'string' ? serializedNode.fileName : undefined,
      reason: serializedNode.reason,
      message: typeof serializedNode.message === 'string' ? serializedNode.message : undefined,
      width: typeof serializedNode.width === 'number' ? serializedNode.width : undefined,
      caption: typeof serializedNode.caption === 'string' ? serializedNode.caption : undefined,
      float: serializedNode.float,
    })
  }

  exportJSON(): SerializedSharedImageNode {
    return {
      type: SHARED_IMAGE_NODE_TYPE,
      version: 1,
      src: this.__src,
      mimeType: this.__mimeType,
      fileName: this.__fileName,
      reason: this.__reason,
      message: this.__message,
      width: this.__width,
      caption: this.__caption,
      float: this.__float,
    }
  }

  /**
   * Never built from pasted or imported HTML. Lexical JSON is the only way one
   * of these exists, and it is only ever written by the share builder.
   */
  static importDOM(): null {
    return null
  }

  exportDOM(): DOMExportOutput {
    if (!isRenderableSharedImageSource(this.__src, this.__mimeType, this.__fileName)) {
      const fallback = document.createElement('p')
      fallback.textContent = this.getTextContent()
      return { element: fallback }
    }
    const image = document.createElement('img')
    image.setAttribute('src', this.__src as string)
    image.setAttribute('alt', this.__caption || this.__fileName || '')
    return { element: image }
  }

  createDOM(): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  isInline(): false {
    return false
  }

  /**
   * What a text extraction (search, export, the markdown fallback) sees. An
   * image contributes its name; a missing attachment contributes the very
   * sentence the reader is shown, so the two never disagree.
   */
  getTextContent(): string {
    if (isRenderableSharedImageSource(this.__src, this.__mimeType, this.__fileName)) {
      return this.__caption || this.__fileName || '[image]'
    }
    return this.__message ?? `[${this.__fileName ?? 'An attachment'} is not included in this share link.]`
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return (
      <SharedImageComponent
        src={this.__src}
        mimeType={this.__mimeType}
        fileName={this.__fileName}
        reason={this.__reason}
        message={this.__message}
        width={this.__width}
        caption={this.__caption}
        float={this.__float}
      />
    )
  }
}

export function $isSharedImageNode(node: LexicalNode | null | undefined): node is SharedImageNode {
  return node instanceof SharedImageNode
}
