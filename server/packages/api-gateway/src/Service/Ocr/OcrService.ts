/**
 * Server-side OCR (optical character recognition) for PDFs, running tesseract.js
 * in Node.
 *
 * ----------------------------------------------------------------------------
 * E2E PRIVACY WARNING
 * ----------------------------------------------------------------------------
 * Standard Notes files are end-to-end encrypted: the server normally only ever
 * sees opaque ciphertext. For this service to OCR a page, the CLIENT must DECRYPT
 * the PDF and upload the resulting page image(s) here. That content therefore
 * LEAVES end-to-end encryption and is visible to this server (and anyone who
 * controls it) for the duration of the request — exactly like the AI assistant
 * proxy. This is the whole reason the feature is opt-in (operator env switch +
 * admin-manageable per-user allow flag). The DEFAULT OCR path stays in the
 * browser (see the web client's pdfOcr/runPdfOcr), where nothing leaves the
 * device. This service holds NOTHING: it recognizes the bytes and returns text;
 * it never persists the image or the extracted text.
 *
 * ----------------------------------------------------------------------------
 * RESOURCE COST + ACCURACY CAVEATS
 * ----------------------------------------------------------------------------
 * tesseract.js in Node spins up a worker that loads a wasm core and per-language
 * trained data (`*.traineddata`, multiple MB, fetched/cached on first use). OCR
 * is CPU-heavy and slow; a single large page can take seconds and pin a core.
 * A long-lived worker is reused across requests (lazy/once-initialized) to avoid
 * paying init repeatedly, but concurrent requests still contend for CPU. Accuracy
 * varies with scan quality, language, and resolution; output is best-effort and
 * never guaranteed.
 *
 * The recognition primitive is injected (see `OcrRecognizer`) so the service can
 * be unit-tested without pulling the multi-MB tesseract.js dependency or a real
 * worker into the test process.
 */

/** A single recognized page's result. */
export interface OcrPageResult {
  /** 1-based page number echoed back from the request. */
  pageNumber: number
  /** Extracted text for the page (may be empty). */
  text: string
}

/** One input image to recognize. */
export interface OcrPageImage {
  pageNumber: number
  /** Raw image bytes (PNG/JPEG) of a rasterized PDF page. */
  image: Buffer
}

/**
 * The low-level recognition primitive: turn image bytes into text for a given
 * language. Injected so tests can mock it; the production binding lazily creates
 * a single reusable tesseract.js worker.
 */
export type OcrRecognizer = (image: Buffer, language: string) => Promise<string>

export interface OcrServiceOptions {
  /** Default tesseract language code when a request does not specify one. */
  defaultLanguage: string
  /**
   * Hard ceiling on a single page image's byte length. Larger images are
   * rejected (not silently truncated) to bound CPU/memory per request.
   */
  maxImageBytes: number
  /** Hard ceiling on the number of pages accepted in one request. */
  maxPages: number
}

/** A bounded, language-validated wrapper around an {@link OcrRecognizer}. */
export class OcrService {
  constructor(
    private readonly recognizer: OcrRecognizer,
    private readonly options: OcrServiceOptions,
  ) {}

  /**
   * Recognize text for a set of page images. Validates the requested language
   * and enforces the page-count / per-image size bounds BEFORE doing any work, so
   * an oversized or malformed request is rejected cheaply. Pages are processed
   * sequentially (the underlying worker is single-threaded) and the input order
   * is preserved in the result.
   */
  async recognizePages(pages: OcrPageImage[], language?: string): Promise<OcrPageResult[]> {
    if (pages.length === 0) {
      return []
    }
    if (pages.length > this.options.maxPages) {
      throw new Error(`Too many pages: ${pages.length} (max ${this.options.maxPages}).`)
    }

    const lang = this.resolveLanguage(language)

    for (const page of pages) {
      if (page.image.length === 0) {
        throw new Error(`Empty image for page ${page.pageNumber}.`)
      }
      if (page.image.length > this.options.maxImageBytes) {
        throw new Error(
          `Image for page ${page.pageNumber} is too large: ${page.image.length} bytes (max ${this.options.maxImageBytes}).`,
        )
      }
    }

    const results: OcrPageResult[] = []
    for (const page of pages) {
      const text = await this.recognizer(page.image, lang)
      results.push({ pageNumber: page.pageNumber, text: (text || '').trim() })
    }
    return results
  }

  /**
   * Validate/normalize a requested language code. We only allow the limited
   * `[a-z]`/`+`/`_` alphabet tesseract uses for `eng`, `eng+deu`, `chi_sim`,
   * etc., to avoid passing arbitrary strings into the worker / file resolution.
   * Falls back to the configured default when absent or invalid.
   */
  resolveLanguage(language?: string): string {
    if (typeof language === 'string') {
      const trimmed = language.trim()
      if (trimmed.length > 0 && /^[a-zA-Z]{2,}([_+][a-zA-Z]{2,})*$/.test(trimmed)) {
        return trimmed
      }
    }
    return this.options.defaultLanguage
  }
}

/**
 * Production {@link OcrRecognizer}: a lazy, once-initialized tesseract.js worker
 * reused across requests. tesseract.js is imported dynamically so the (heavy)
 * dependency is only loaded when server OCR is actually exercised, and the worker
 * is created for a given language on first use and re-created if the language
 * changes between requests (tesseract workers are bound to a language set).
 */
export function createTesseractRecognizer(): OcrRecognizer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workerPromise: Promise<any> | undefined
  let workerLanguage: string | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getWorker = async (language: string): Promise<any> => {
    if (workerPromise && workerLanguage === language) {
      return workerPromise
    }
    if (workerPromise && workerLanguage !== language) {
      // Language changed: terminate the old worker before creating a new one.
      try {
        const old = await workerPromise
        await old.terminate()
      } catch {
        /* noop */
      }
      workerPromise = undefined
    }
    workerLanguage = language
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    workerPromise = (async () => {
      const Tesseract = (await import('tesseract.js')) as unknown as {
        createWorker: (lang: string) => Promise<unknown>
      }
      return Tesseract.createWorker(language)
    })()
    return workerPromise
  }

  return async (image: Buffer, language: string): Promise<string> => {
    const worker = await getWorker(language)
    const result = (await worker.recognize(image)) as { data?: { text?: string } }
    return result?.data?.text ?? ''
  }
}
