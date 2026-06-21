/**
 * SERVER-SIDE OCR runner.
 *
 * ----------------------------------------------------------------------------
 * E2E PRIVACY WARNING (the whole reason this is opt-in)
 * ----------------------------------------------------------------------------
 * Unlike the browser OCR path (`runPdfOcr.ts`), this runner RASTERIZES the
 * already-decrypted, image-only PDF pages and UPLOADS those page images to the
 * server's `/v1/ocr/recognize` endpoint. That content LEAVES end-to-end
 * encryption: the server (and anyone who controls it) can read the uploaded page
 * imagery for the duration of the request — exactly like the AI assistant proxy.
 *
 * It is therefore only ever used when the user EXPLICITLY chooses "Run OCR on
 * server" (with the inline warning shown), and only when the server reports it
 * available (operator env master switch AND the admin-managed per-user allow
 * flag). The default OCR path stays in the browser, where nothing leaves the
 * device.
 *
 * Like the browser runner, this reuses the embedded text layer where present and
 * only sends image-only pages for recognition, then returns both so the caller
 * can merge + cache the whole-document text via the SAME helpers as browser OCR.
 */

import { OcrPageText, pageNeedsOcr } from './pdfOcr'
import { joinTextItems } from './pdfSearch'
import type { PDFPageProxy } from './pdfjs'
import type { OcrProgress } from './runPdfOcr'

/** Posts the page images to the server and returns the recognized text. */
export type ServerOcrPoster = (
  body: { language: string; pages: Array<{ pageNumber: number; imageBase64: string }> },
  signal?: AbortSignal,
) => Promise<{ status: number; ok: boolean; data: { pages?: OcrPageText[]; error?: { message?: string } } }>

export type RunServerPdfOcrParams = {
  pages: PDFPageProxy[]
  /** tesseract language code, e.g. "eng" (the server validates/falls back). */
  language: string
  /** Scale to rasterize image-only pages at before upload (higher = better/bigger). */
  renderScale?: number
  /** The authenticated POST to /v1/ocr/recognize, supplied by the component. */
  post: ServerOcrPoster
  onProgress?: (progress: OcrProgress) => void
  signal?: AbortSignal
}

export type RunServerPdfOcrResult = {
  /** Embedded text for every page (so the caller can merge + cache the whole doc). */
  embedded: OcrPageText[]
  /** OCR text for the image-only pages only. */
  ocr: OcrPageText[]
}

/** Render a single PDF page to an offscreen canvas at the given scale. */
async function renderPageToCanvas(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not get 2D canvas context for OCR rendering')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderTask = page.render({ canvasContext: context, viewport } as any)
  await (renderTask as unknown as { promise: Promise<void> }).promise
  return canvas
}

/** Convert a canvas to a base64 PNG payload (no data-URL prefix). */
function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png')
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/**
 * Extract text from a PDF using SERVER OCR: reuse the embedded text layer where
 * present, rasterize the image-only pages, upload them, and return the server's
 * extracted text. Returns both embedded + ocr so the caller can merge + cache.
 */
export async function runServerPdfOcr({
  pages,
  language,
  renderScale = 2,
  post,
  onProgress,
  signal,
}: RunServerPdfOcrParams): Promise<RunServerPdfOcrResult> {
  // 1. Pull embedded text for every page; decide which pages need OCR.
  const embedded: OcrPageText[] = []
  const pagesNeedingOcr: PDFPageProxy[] = []
  for (const page of pages) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const content = await page.getTextContent()
    const text = joinTextItems(content.items)
    embedded.push({ pageNumber: page.pageNumber, text })
    if (pageNeedsOcr(text)) {
      pagesNeedingOcr.push(page)
    }
  }

  const totalPages = pagesNeedingOcr.length
  if (totalPages === 0) {
    onProgress?.({ totalPages: 0, completedPages: 0, pageProgress: 1 })
    return { embedded, ocr: [] }
  }

  // 2. Rasterize the image-only pages to base64 PNGs. Report progress as we go;
  //    the server does the actual (opaque) recognition, so per-page progress is
  //    rendering-based rather than recognition-based.
  const imagePages: Array<{ pageNumber: number; imageBase64: string }> = []
  let prepared = 0
  for (const page of pagesNeedingOcr) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    onProgress?.({ totalPages, completedPages: prepared, currentPageNumber: page.pageNumber, pageProgress: 0 })
    const canvas = await renderPageToCanvas(page, renderScale)
    imagePages.push({ pageNumber: page.pageNumber, imageBase64: canvasToBase64Png(canvas) })
    canvas.width = 0
    canvas.height = 0
    prepared += 1
    onProgress?.({ totalPages, completedPages: prepared, currentPageNumber: page.pageNumber, pageProgress: 1 })
  }

  // 3. One round-trip to the server with all image-only pages. (E2E DOWNGRADE.)
  const response = await post({ language, pages: imagePages }, signal)
  if (!response.ok) {
    const message = response.data?.error?.message || `Server OCR failed (${response.status}).`
    throw new Error(message)
  }

  const ocr = (response.data.pages ?? []).map((page) => ({
    pageNumber: page.pageNumber,
    text: (page.text || '').trim(),
  }))

  return { embedded, ocr }
}
