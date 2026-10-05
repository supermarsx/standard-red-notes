import { useApplication } from '@/Components/ApplicationProvider'
import Icon from '@/Components/Icon/Icon'
import Spinner from '@/Components/Spinner/Spinner'
import { isDesktopApplication } from '@/Utils'
import { BlockWithAlignableContents } from '@lexical/react/LexicalBlockWithAlignableContents'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { classNames, Platform } from '@standardnotes/snjs'
import { $getNodeByKey, CLICK_COMMAND, COMMAND_PRIORITY_LOW, ElementFormatType, NodeKey } from 'lexical'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { $createFileNode } from '../EncryptedFilePlugin/Nodes/FileUtils'
import { RemoteImageNode } from './RemoteImageNode'
import { isIOS } from '@standardnotes/ui-services'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import SuperEmbeddedImage from '../ImageTools/SuperEmbeddedImage'
import { ImageFloat } from '../ImageTools/ImageToolsTypes'
import { fetchBoundedSourceBytes, isRenderableAttachmentSource } from '@/Components/FilePreview/fetchBoundedSourceBytes'
import { MAX_LOCAL_FILE_SIZE } from '@/Constants/Constants'

export const REMOTE_IMAGE_SAVE_IDLE_TIMEOUT_MS = 45_000

const ExtensionsByImageMimeType: Record<string, string> = {
  'image/apng': 'apng',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(bytes.byteLength, start + length)))

/**
 * The BYTES decide the type, not a remote `Content-Type` and not the data URL's
 * own label. The preview path re-checks the signature against the stored MIME
 * (`hasSupportedImageSignature`), so a saved file whose MIME was taken on trust
 * from the source would upload fine and then refuse to render.
 */
function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    return 'image/png'
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return 'image/gif'
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp'
  }
  if (bytes.byteLength >= 2 && ascii(bytes, 0, 2) === 'BM') {
    return 'image/bmp'
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 4))) {
    return 'image/avif'
  }
  return undefined
}

/** The data URL's own label, used only when the bytes carry no known signature. */
function declaredDataUrlMimeType(source: string): string | undefined {
  const normalized = source.trimStart()
  if (!normalized.toLowerCase().startsWith('data:')) {
    return undefined
  }
  const separator = normalized.indexOf(',')
  if (separator === -1) {
    return undefined
  }
  const declared = normalized.slice('data:'.length, separator).split(';', 1)[0].trim().toLowerCase()
  return declared.length > 0 ? declared : undefined
}

/**
 * A name a human (and `parseFileName`) can work with.
 *
 * This used to be the source string itself, which for a `data:` image meant a
 * multi-megabyte base64 blob became the FileItem's NAME — synced, rendered into
 * `title=` attributes, and printed wherever the name is logged.
 */
function fileNameForImageSource(source: string, alt: string | undefined, mimeType: string): string {
  const extension = ExtensionsByImageMimeType[mimeType] ?? 'img'

  if (!source.trimStart().toLowerCase().startsWith('data:')) {
    try {
      const base = new URL(source, globalThis.location?.href ?? 'https://local.invalid/').pathname.split('/').pop()
      if (base && base.length > 0 && base.length <= 128) {
        return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.${extension}`
      }
    } catch {
      // fall through to the generic name
    }
  }

  const fromAlt = (alt ?? '').trim().replace(/[\\/:*?"<>|]/g, '')
  return fromAlt.length > 0 && fromAlt.length <= 64 ? `${fromAlt}.${extension}` : `image.${extension}`
}

type Props = {
  src: string
  alt?: string
  node: RemoteImageNode
  className: Readonly<{
    base: string
    focus: string
  }>
  format: ElementFormatType | null
  setFormat: (format: ElementFormatType) => void
  nodeKey: NodeKey
  width: number | undefined
  setWidth: (width: number | undefined) => void
  caption: string | undefined
  setCaption: (caption: string | undefined) => void
  float: ImageFloat
  setFloat: (float: ImageFloat) => void
}

const RemoteImageComponent = ({
  className,
  src,
  alt,
  node,
  format,
  nodeKey,
  setFormat,
  width,
  setWidth,
  caption,
  setCaption,
  float,
  setFloat,
}: Props) => {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()

  const [didImageLoad, setDidImageLoad] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  /**
   * A node persisted before the import-time check existed can still hold a
   * `file:///…` (or otherwise unloadable) source. Rendering it would ask an
   * https page to load a `file://` subresource, which the browser refuses with
   * "Security Error: Content at https://… may not load or link to file:///…" on
   * every single open of the note. Show the failure panel instead of emitting
   * the request.
   */
  const isSafeSource = useMemo(() => isRenderableAttachmentSource(src), [src])

  useEffect(() => {
    setDidImageLoad(false)
    setImageFailed(false)
  }, [src])

  const fetchAndUploadImage = useCallback(async () => {
    setIsSaving(true)
    try {
      /**
       * Bounded, and — critically — never `fetch()`es a `data:` source. A CSP
       * with a `connect-src` that does not list `data:` blocks such a fetch and
       * reports the violation by printing the ENTIRE data URL (a whole base64
       * image) into the console, while this action silently fails.
       */
      const bytes = await fetchBoundedSourceBytes(src, {
        maximumBytes: MAX_LOCAL_FILE_SIZE,
        idleTimeoutMs: REMOTE_IMAGE_SAVE_IDLE_TIMEOUT_MS,
      })

      const mimeType = detectImageMimeType(bytes) ?? declaredDataUrlMimeType(src) ?? 'application/octet-stream'
      const file = new File([bytes as BlobPart], fileNameForImageSource(src, alt, mimeType), { type: mimeType })
      bytes.fill(0)

      const { filesController } = application

      const uploadedFile = await filesController.uploadNewFile(file, { showToast: false })

      if (!uploadedFile) {
        return
      }

      editor.update(() => {
        const fileNode = $createFileNode(uploadedFile.uuid)
        node.replace(fileNode)
      })
    } catch (error) {
      // Never log the source itself: for a data URL that is the whole image.
      console.error('Could not save the embedded image to Files', error instanceof Error ? error.message : error)
    } finally {
      setIsSaving(false)
    }
  }, [alt, application, editor, node, src])

  const isBase64OrDataUrl = src.startsWith('data:')
  const canShowSaveButton = application.isNativeMobileWeb() || isDesktopApplication() || isBase64OrDataUrl
  const openableRemoteUrl = (() => {
    try {
      const parsed = new URL(src)
      return parsed.protocol === 'https:' ? parsed.toString() : undefined
    } catch {
      return undefined
    }
  })()

  const ref = useRef<HTMLDivElement>(null)
  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        if (ref.current?.contains(event.target as Node)) {
          event.preventDefault()

          $getNodeByKey(nodeKey)?.selectEnd()

          setTimeout(() => {
            setSelected(!isSelected)
          })
          return true
        }

        return false
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, isSelected, nodeKey, setSelected])

  const changeAlignment = useCallback(
    (format: ElementFormatType) => {
      editor.update(() => {
        setFormat(format)
      })
    },
    [editor, setFormat],
  )

  const changeWidth = useCallback(
    (newWidth: number | undefined) => editor.update(() => setWidth(newWidth)),
    [editor, setWidth],
  )
  const changeCaption = useCallback(
    (newCaption: string | undefined) => editor.update(() => setCaption(newCaption)),
    [editor, setCaption],
  )
  const changeFloat = useCallback((newFloat: ImageFloat) => editor.update(() => setFloat(newFloat)), [editor, setFloat])

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div
        ref={ref}
        className="group relative flex min-h-[2rem] flex-col gap-2.5"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {imageFailed || !isSafeSource ? (
          <div
            className="border-border bg-contrast flex min-h-32 flex-col items-center justify-center gap-2 rounded border p-4 text-center"
            role="alert"
            data-unsafe-image-source={!isSafeSource ? 'true' : undefined}
          >
            <span className="text-passive-0">
              {isSafeSource
                ? 'This image could not be loaded.'
                : 'This image points at a local file on the device it was pasted from, so it could not be loaded.'}
            </span>
            <div className="flex flex-wrap items-center justify-center gap-2" data-srn-print-exclude="true">
              {isSafeSource ? (
                <button
                  type="button"
                  className="border-border hover:bg-default rounded border px-2.5 py-1.5 text-sm"
                  onClick={(event) => {
                    event.stopPropagation()
                    setImageFailed(false)
                  }}
                >
                  Retry
                </button>
              ) : null}
              {openableRemoteUrl ? (
                <a
                  href={openableRemoteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  className="border-border hover:bg-default rounded border px-2.5 py-1.5 text-sm"
                  onClick={(event) => event.stopPropagation()}
                >
                  Open image in a new tab
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <SuperEmbeddedImage
            src={src}
            alt={alt}
            alignment={format ?? ''}
            onAlignmentChange={changeAlignment}
            width={width}
            onWidthChange={changeWidth}
            caption={caption}
            onCaptionChange={changeCaption}
            float={float}
            onFloatChange={changeFloat}
            isSelected={isSelected}
            onImageLoad={() => {
              setImageFailed(false)
              setDidImageLoad(true)
            }}
            onImageError={() => {
              setDidImageLoad(false)
              setImageFailed(true)
            }}
            referrerPolicy="no-referrer"
          />
        )}
        {didImageLoad && canShowSaveButton && (
          <button
            className={classNames(
              'border-border bg-default flex items-center gap-2.5 rounded border px-2.5 py-1.5',
              !isSaving && 'hover:bg-info hover:text-info-contrast',
            )}
            onClick={() => {
              const isIOSPlatform = application.platform === Platform.Ios || isIOS()
              if (isIOSPlatform && document.activeElement) {
                ;(document.activeElement as HTMLElement).blur()
              }
              fetchAndUploadImage().catch(console.error)
            }}
            disabled={isSaving}
          >
            {isSaving ? (
              <>
                <Spinner className="h-4 w-4" />
                Saving...
              </>
            ) : (
              <>
                <Icon type="download" />
                Save image to Files
              </>
            )}
          </button>
        )}
      </div>
    </BlockWithAlignableContents>
  )
}

export default RemoteImageComponent
