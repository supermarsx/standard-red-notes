import { WebApplication } from '@/Application/WebApplication'
import { FileItem, SNNote, isFile } from '@standardnotes/snjs'
import { parseFileName } from '@standardnotes/utils'
import { ToastType, addToast, updateToast, dismissToast } from '@standardnotes/toast'

/**
 * Minimal shape of an image we want to put into the ZIP. We keep this decoupled
 * from `FileItem`/`SNFile` so the filename logic below stays purely testable.
 */
export type ImageEntryDescriptor = {
  /** A human readable base name, e.g. the file's title or the remote URL basename. */
  name: string
  /** The image mime type if known (e.g. "image/png"). Used to recover an extension. */
  mimeType?: string
}

/** Maps an image mime type to a sensible file extension when the name has none. */
const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
}

/**
 * Whether a mime type / file name represents an image we should include.
 * Prefers the mime type; falls back to a known image extension on the name.
 */
export function isImageFile(mimeType: string | undefined, name: string | undefined): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith('image/')) {
    return true
  }
  const ext = name ? parseFileName(name).ext.toLowerCase() : ''
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif', 'avif'].includes(ext)
}

/**
 * Derives a file extension for an image: keeps the extension already present on the
 * name if any, otherwise infers it from the mime type. Returns '' when unknown.
 */
export function extensionForImage(name: string, mimeType: string | undefined): string {
  const { ext } = parseFileName(name)
  if (ext) {
    return ext.toLowerCase()
  }
  if (mimeType) {
    return MIME_TYPE_TO_EXTENSION[mimeType.toLowerCase()] ?? ''
  }
  return ''
}

/**
 * Builds a filesystem-safe, unique ZIP entry name for an image. Reuses the same
 * sanitization rules as note backups (illegal Windows chars -> '_', collapsed
 * whitespace, trailing dot/space removal) and guarantees uniqueness within the
 * archive by suffixing ` (2)`, ` (3)`, ... on collisions.
 *
 * @param descriptor the image's display name + optional mime type
 * @param usedNames  set of names already added to the archive (mutated)
 */
export function getImageEntryFileName(descriptor: ImageEntryDescriptor, usedNames: Set<string>): string {
  const { name: rawBase } = parseFileName(descriptor.name)
  const ext = extensionForImage(descriptor.name, descriptor.mimeType)

  const safeBase = sanitizeImageName(rawBase || 'image')
  const suffix = ext ? `.${ext}` : ''

  let candidate = `${safeBase}${suffix}`
  let counter = 2
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${safeBase} (${counter})${suffix}`
    counter += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

/**
 * Sanitizes a string into a Windows-safe file-name fragment. Mirrors the rules
 * used by the note-backup naming helper (`sanitizeBackupTitle`): collapse
 * whitespace, strip ASCII control chars, replace `\ / : * ? " < > |` with `_`,
 * trim trailing dots/spaces, and fall back to "image" when nothing remains.
 */
export function sanitizeImageName(name: string): string {
  const cleaned = (name ?? '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'g'), '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : 'image'
}

const REMOTE_IMAGE_NODE_TYPE = 'unencrypted-image'

/**
 * Extracts remote image URLs (RemoteImageNode `src`s) from a Super note's JSON
 * content. RemoteImageNode serializes with `"type":"unencrypted-image"` and a
 * `src` URL. We walk the parsed Lexical JSON tree rather than regex-scraping so
 * we only pick up genuine remote-image nodes. Returns [] for non-Super / invalid.
 */
export function parseRemoteImageUrlsFromSuperNote(noteText: string): string[] {
  if (!noteText || !noteText.includes(REMOTE_IMAGE_NODE_TYPE)) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(noteText)
  } catch {
    return []
  }

  const urls: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    const record = node as Record<string, unknown>
    if (record.type === REMOTE_IMAGE_NODE_TYPE && typeof record.src === 'string' && record.src.length > 0) {
      urls.push(record.src)
    }
    const children = record.children
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child)
      }
    }
    // Lexical roots are nested under a top-level `root` key.
    if (record.root) {
      visit(record.root)
    }
  }

  visit(parsed)
  return urls
}

/** Derives a readable base name for a remote image from its URL. */
export function remoteImageNameFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url, 'https://example.invalid')
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (last) {
      return decodeURIComponent(last)
    }
  } catch {
    /* fall through */
  }
  return `remote-image-${index + 1}`
}

/**
 * Collects the uploaded image `SNFile`s associated with a note. A note both
 * references files (Super embeds) and is referenced by files, so we union both
 * directions and de-duplicate by uuid, then filter to images by mime/extension.
 */
export function collectNoteImageFiles(application: WebApplication, note: SNNote): FileItem[] {
  const referenced = application.items.referencesForItem(note).filter(isFile)
  const referencing = application.items.itemsReferencingItem(note).filter(isFile)

  const byUuid = new Map<string, FileItem>()
  for (const file of [...referenced, ...referencing]) {
    if (isImageFile(file.mimeType, file.name)) {
      byUuid.set(file.uuid, file)
    }
  }
  return Array.from(byUuid.values())
}

type CollectedImage =
  | { kind: 'file'; file: FileItem }
  | { kind: 'remote'; url: string; index: number }

/**
 * Downloads every image attached to a note and triggers a single ZIP download.
 *
 * Uploaded images are fetched via the files service (decrypted bytes). Remote
 * images (RemoteImageNode URLs) are fetched best-effort with `fetch` — these may
 * be blocked by CORS, in which case they are skipped and counted. The resulting
 * ZIP is named after the (sanitized) note title.
 */
export async function downloadNoteImagesAsZip(application: WebApplication, note: SNNote): Promise<void> {
  const imageFiles = collectNoteImageFiles(application, note)
  const remoteUrls = parseRemoteImageUrlsFromSuperNote(note.text)

  const collected: CollectedImage[] = [
    ...imageFiles.map((file) => ({ kind: 'file' as const, file })),
    ...remoteUrls.map((url, index) => ({ kind: 'remote' as const, url, index })),
  ]

  if (collected.length === 0) {
    addToast({ type: ToastType.Regular, message: 'This note has no images' })
    return
  }

  const toastId = addToast({
    type: ToastType.Progress,
    message: `Preparing ${collected.length} image${collected.length === 1 ? '' : 's'}...`,
    progress: 0,
  })

  const zipLib = await import('@zip.js/zip.js')
  const zipFS = new zipLib.fs.FS()
  const { root } = zipFS

  const usedNames = new Set<string>()
  let added = 0
  let skipped = 0

  for (let i = 0; i < collected.length; i++) {
    const item = collected[i]
    try {
      let blob: Blob | undefined
      let descriptor: ImageEntryDescriptor

      if (item.kind === 'file') {
        blob = await application.filesController.getFileBlob(item.file)
        descriptor = { name: item.file.name, mimeType: item.file.mimeType }
      } else {
        const response = await fetch(item.url)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        blob = await response.blob()
        descriptor = {
          name: remoteImageNameFromUrl(item.url, item.index),
          mimeType: blob.type || undefined,
        }
      }

      if (!blob) {
        skipped += 1
        continue
      }

      const entryName = getImageEntryFileName(descriptor, usedNames)
      root.addBlob(entryName, blob)
      added += 1
    } catch (error) {
      console.error('Failed to add image to zip', error)
      skipped += 1
    }

    updateToast(toastId, {
      message: `Collected ${i + 1} of ${collected.length} image${collected.length === 1 ? '' : 's'}...`,
      progress: Math.floor(((i + 1) / collected.length) * 100),
    })
  }

  dismissToast(toastId)

  if (added === 0) {
    addToast({
      type: ToastType.Error,
      message: `Could not download any images${skipped > 0 ? ` (${skipped} skipped)` : ''}.`,
    })
    return
  }

  const zipBlob = await zipFS.exportBlob()
  const zipName = `${sanitizeImageName(note.title)}.zip`

  const link = document.createElement('a')
  link.href = window.URL.createObjectURL(zipBlob)
  link.setAttribute('download', zipName)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(link.href)

  addToast({
    type: ToastType.Success,
    message:
      skipped > 0
        ? `Downloaded ${added} image${added === 1 ? '' : 's'} (${skipped} skipped).`
        : `Downloaded ${added} image${added === 1 ? '' : 's'}.`,
  })
}
