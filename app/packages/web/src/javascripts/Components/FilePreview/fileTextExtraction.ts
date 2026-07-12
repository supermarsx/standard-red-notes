// On-device text extraction for AI tag suggestions on FILES. This is deliberately
// honest about what can and cannot be read as text on the client, because the
// extracted text (if any) is what gets sent to the configured AI provider:
//
//  - text-like files (text/*, json/xml/csv/markdown/yaml): decrypted bytes are
//    downloaded, decoded with TextDecoder, and clamped to the tag-input budget.
//  - PDFs: text is only available when the operator OCR flag is on AND the file
//    has already been extracted by the PDF preview (which caches per-page text on
//    device). We reuse that cache rather than re-run the multi-MB tesseract
//    pipeline here. Flag off or no cache => metadata only.
//  - everything else (images without OCR, docx/xlsx, zip, audio/video): encrypted
//    binary with no local text => metadata only.
//
// The returned `onlyMetadataAvailable` flag drives the modal's exposure warning so
// the user is told, per file, whether any contents were sent.

import { WebApplication } from '@/Application/WebApplication'
import { concatenateUint8Arrays } from '@/Utils'
import { FileItem } from '@standardnotes/snjs'
import { DEFAULT_TAG_INPUT_BUDGET, prepareTagInputText } from '@/Assistant/tagSuggestions'
import { buildOcrFileKey, getOcrServerConfig, joinPageTexts, readOcrCache } from './pdfOcr'

/**
 * Whether a mime type is one we can read as text on the client. Pure — no app or
 * network. Covers text/*, the common structured-text application types, and any
 * `application/*+json` / `application/*+xml` suffix types.
 */
export function isExtractableTextMime(mime: string): boolean {
  const m = (mime ?? '').trim().toLowerCase()
  if (!m) {
    return false
  }
  if (m.startsWith('text/')) {
    return true
  }
  const allow = new Set([
    'application/json',
    'application/xml',
    'application/csv',
    'application/markdown',
    'application/x-yaml',
    'application/yaml',
    'application/x-ndjson',
  ])
  if (allow.has(m)) {
    return true
  }
  if (m.startsWith('application/') && (m.endsWith('+json') || m.endsWith('+xml'))) {
    return true
  }
  return false
}

export interface FileTagTextResult {
  /** Extracted text, clamped to the tag-input budget. '' when none is available. */
  text: string
  /**
   * True when NO readable text could be extracted, so only the file's metadata
   * (name + type + size) will be sent to the AI. Drives the modal's exposure copy.
   */
  onlyMetadataAvailable: boolean
}

/**
 * Extract text usable for tag suggestions from a file, honestly. Returns
 * metadata-only (`text: '', onlyMetadataAvailable: true`) for anything we cannot
 * read as text on-device. Never throws for the caller's control flow — download
 * errors degrade to metadata-only.
 */
export async function extractFileTextForTags(
  application: WebApplication,
  file: FileItem,
  options: { signal?: AbortSignal; budget?: number } = {},
): Promise<FileTagTextResult> {
  const budget = options.budget ?? DEFAULT_TAG_INPUT_BUDGET
  const mime = file.mimeType ?? ''

  if (isExtractableTextMime(mime)) {
    const chunks: Uint8Array[] = []
    const error = await application.files.downloadFile(file, async (decryptedChunk) => {
      chunks.push(decryptedChunk)
    })
    if (error) {
      return { text: '', onlyMetadataAvailable: true }
    }
    const bytes = concatenateUint8Arrays(chunks)
    const text = prepareTagInputText(new TextDecoder().decode(bytes), budget)
    return { text, onlyMetadataAvailable: text.length === 0 }
  }

  if (mime === 'application/pdf') {
    // Only reuse extracted PDF text when the operator OCR flag is on; and only when
    // the preview has already run and cached it locally (keyed the same way).
    if (!getOcrServerConfig().enabled) {
      return { text: '', onlyMetadataAvailable: true }
    }
    const cached = readOcrCache(buildOcrFileKey(file.uuid, file.remoteIdentifier))
    if (!cached || cached.length === 0) {
      return { text: '', onlyMetadataAvailable: true }
    }
    const text = prepareTagInputText(joinPageTexts(cached), budget)
    return { text, onlyMetadataAvailable: text.length === 0 }
  }

  // Encrypted binary with no on-device text: metadata (filename + type) only.
  return { text: '', onlyMetadataAvailable: true }
}
