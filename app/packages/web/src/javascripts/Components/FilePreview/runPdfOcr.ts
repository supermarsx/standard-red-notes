/**
 * The impure OCR runner: lazy-loads tesseract.js, renders the image-only PDF
 * pages to canvas, and recognizes text from them. Kept separate from the pure
 * helpers in `pdfOcr.ts` (which are unit-tested) and dynamically imported so the
 * heavy tesseract.js bundle is code-split out of the main app.
 *
 * IMPORTANT (E2E): this runs entirely in the browser on already-decrypted page
 * canvases. The server never sees the PDF; it only toggles the feature on/off
 * and provides a default language. tesseract.js downloads its worker, wasm core
 * and language-data (`*.traineddata`) at runtime from its CDN — that is heavy
 * (multiple MB) and slow, and OCR accuracy varies with scan quality. The UI
 * surfaces these caveats.
 */

import { OcrPageText, pageNeedsOcr } from './pdfOcr'
import { joinTextItems } from './pdfSearch'
import type { PDFPageProxy } from './pdfjs'

export type OcrProgress = {
  /** Pages that needed OCR (image-only pages). */
  totalPages: number
  /** How many of those pages are fully done. */
  completedPages: number
  /** 1-based page number currently being processed (undefined when idle). */
  currentPageNumber?: number
  /** tesseract's 0..1 progress within the current page. */
  pageProgress: number
}

export type RunPdfOcrParams = {
  pages: PDFPageProxy[]
  /** tesseract language code, e.g. "eng". */
  language: string
  /** Scale to rasterize image-only pages at before OCR (higher = better/slower). */
  renderScale?: number
  onProgress?: (progress: OcrProgress) => void
  /** Aborts the run between pages. */
  signal?: AbortSignal
}

export type RunPdfOcrResult = {
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

/**
 * Extract text from a PDF: reuse the embedded text layer where present, and run
 * tesseract OCR over the image-only pages. Returns both so the caller can merge
 * + cache the merged, whole-document text.
 */
export async function runPdfOcr({
  pages,
  language,
  renderScale = 2,
  onProgress,
  signal,
}: RunPdfOcrParams): Promise<RunPdfOcrResult> {
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

  const ocr: OcrPageText[] = []
  const totalPages = pagesNeedingOcr.length

  if (totalPages === 0) {
    onProgress?.({ totalPages: 0, completedPages: 0, pageProgress: 1 })
    return { embedded, ocr }
  }

  // 2. Lazy-load tesseract.js (code-split) and create a worker for the language.
  //    `await import` keeps the multi-MB bundle out of the main chunk.
  const Tesseract = await import('tesseract.js')

  let completedPages = 0
  const worker = await Tesseract.createWorker(language, undefined, {
    // tesseract.js logs { status, progress } during recognition.
    logger: (m: { status?: string; progress?: number }) => {
      if (m && typeof m.progress === 'number' && m.status === 'recognizing text') {
        onProgress?.({
          totalPages,
          completedPages,
          currentPageNumber: pagesNeedingOcr[completedPages]?.pageNumber,
          pageProgress: m.progress,
        })
      }
    },
  })

  try {
    for (const page of pagesNeedingOcr) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      onProgress?.({
        totalPages,
        completedPages,
        currentPageNumber: page.pageNumber,
        pageProgress: 0,
      })
      const canvas = await renderPageToCanvas(page, renderScale)
      const {
        data: { text },
      } = await worker.recognize(canvas)
      // Free the canvas eagerly (large pages are memory-heavy).
      canvas.width = 0
      canvas.height = 0
      ocr.push({ pageNumber: page.pageNumber, text: (text || '').trim() })
      completedPages += 1
      onProgress?.({
        totalPages,
        completedPages,
        currentPageNumber: page.pageNumber,
        pageProgress: 1,
      })
    }
  } finally {
    try {
      await worker.terminate()
    } catch {
      /* noop */
    }
  }

  return { embedded, ocr }
}
