/**
 * Pure helpers for the PDF "Extract text (OCR)" feature.
 *
 * ----------------------------------------------------------------------------
 * WHY OCR RUNS IN THE BROWSER (end-to-end encryption)
 * ----------------------------------------------------------------------------
 * Files in this app are end-to-end encrypted: the server only ever stores
 * opaque ciphertext and NEVER sees the decrypted PDF bytes. It therefore
 * physically cannot run OCR. The client already decrypts the PDF to display it,
 * so OCR has to happen here, on the already-decrypted page canvases.
 *
 * "Server-configurable" consequently means the server exposes an *enable flag*
 * (and a default language) that gates whether the client offers the OCR action
 * — it is NOT server-side processing. See `getOcrServerConfig` below and the
 * `window.ocrEnabled` / `window.ocrDefaultLanguage` globals.
 *
 * The functions in THIS module are deliberately free of any PDF.js / DOM /
 * tesseract.js dependency so they can be unit-tested in isolation:
 *   - `pageNeedsOcr`        — does a page have too little embedded text to skip?
 *   - `mergeOcrWithEmbedded`— combine OCR output with embedded text per page.
 *   - cache read/write      — persist results so we never re-OCR a file.
 */

/** Per-page extracted text (mirrors `PdfPageText` in pdfSearch). */
export type OcrPageText = {
  /** 1-based page number. */
  pageNumber: number
  /** Text for this page (embedded, OCR'd, or merged). */
  text: string
}

/**
 * Heuristic: a PDF page needs OCR when its *embedded* text layer is empty or
 * near-empty. Scanned / image-only PDFs have no real text layer, so
 * `page.getTextContent()` returns nothing (or a few stray characters). Pages
 * that already carry a healthy text layer are skipped — OCR is slow and would
 * only degrade their (already perfect) embedded text.
 *
 * @param embeddedText the page's embedded text (e.g. from `joinTextItems`).
 * @param minChars     minimum number of *non-whitespace* characters a page must
 *                     have to be considered "has text". Default 16.
 */
export function pageNeedsOcr(embeddedText: string, minChars = 16): boolean {
  const meaningful = embeddedText.replace(/\s+/g, '')
  return meaningful.length < minChars
}

/**
 * Merge OCR results into the list of embedded-text pages. For each page we keep
 * the embedded text when it exists, and fall back to (or append) the OCR text
 * for image-only pages. The result is a per-page list the viewer can feed into
 * `pdfSearch` so the WHOLE document becomes searchable, plus a single joined
 * string for "copy all extracted text".
 *
 * Pages are matched by `pageNumber`. OCR text for a page that already has
 * embedded text is appended (separated by a newline) rather than replacing it,
 * so partially-scanned pages don't lose their native text.
 */
export function mergeOcrWithEmbedded(embedded: OcrPageText[], ocr: OcrPageText[]): OcrPageText[] {
  const ocrByPage = new Map<number, string>()
  for (const page of ocr) {
    const text = (page.text || '').trim()
    if (text.length > 0) {
      ocrByPage.set(page.pageNumber, text)
    }
  }

  return embedded.map((page) => {
    const embeddedText = (page.text || '').trim()
    const ocrText = ocrByPage.get(page.pageNumber)
    if (!ocrText) {
      return { pageNumber: page.pageNumber, text: embeddedText }
    }
    // A page with a healthy embedded text layer keeps it verbatim — OCR is only
    // meant to fill in image-only / sparse pages, and re-OCR'ing good text would
    // only degrade it. (In practice the runner only OCRs sparse pages anyway.)
    if (!pageNeedsOcr(embeddedText)) {
      return { pageNumber: page.pageNumber, text: embeddedText }
    }
    if (embeddedText.length === 0) {
      return { pageNumber: page.pageNumber, text: ocrText }
    }
    // Sparse-but-not-empty page (partially scanned): keep embedded, append OCR.
    return { pageNumber: page.pageNumber, text: `${embeddedText}\n${ocrText}` }
  })
}

/** Join per-page text into one document string (for copy / full-text search). */
export function joinPageTexts(pages: OcrPageText[]): string {
  return pages
    .map((p) => p.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
//
// OCR is expensive, so we cache the extracted per-page text keyed by the file.
// We deliberately use a bounded LOCAL cache (localStorage) rather than the file
// item's appData: the extracted text can be large and the file item is synced
// (and, for shared files, visible to collaborators) — writing megabytes of OCR
// text into a synced, re-encrypted item on every open would be wasteful. A
// bounded local cache keeps the cost on the device that paid for the OCR.

/** Schema version — bump to invalidate all cached entries on format changes. */
const CACHE_VERSION = 1
const CACHE_PREFIX = 'sn-pdf-ocr-cache'
/** Max number of cached files kept (LRU-ish: oldest evicted first). */
const MAX_CACHE_ENTRIES = 20
/** Skip caching entries larger than this (chars) to avoid blowing the quota. */
const MAX_ENTRY_CHARS = 2_000_000

export type OcrCacheEntry = {
  version: number
  /** Identity of the file content this OCR belongs to (uuid + remote id). */
  fileKey: string
  /** When the entry was written (ms) — used for LRU eviction. */
  storedAt: number
  pages: OcrPageText[]
}

/**
 * Build a stable cache key for a file. Combining the uuid with the file's
 * `remoteIdentifier` (which changes whenever the encrypted content changes)
 * means an *edited / replaced* file is treated as a cache miss and re-OCR'd,
 * while reopening the SAME file is a hit. We never re-OCR unchanged files.
 */
export function buildOcrFileKey(fileUuid: string, remoteIdentifier?: string): string {
  return remoteIdentifier ? `${fileUuid}:${remoteIdentifier}` : fileUuid
}

function storageKeyFor(fileKey: string): string {
  return `${CACHE_PREFIX}:v${CACHE_VERSION}:${fileKey}`
}

/** Minimal subset of the Web Storage API we depend on (for easy mocking). */
export type OcrCacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function getDefaultStorage(): OcrCacheStorage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    // localStorage can throw in some privacy modes / sandboxed iframes.
    return undefined
  }
}

/** Read a cached OCR result, or `undefined` on miss / parse error. */
export function readOcrCache(fileKey: string, storage = getDefaultStorage()): OcrPageText[] | undefined {
  if (!storage) {
    return undefined
  }
  try {
    const raw = storage.getItem(storageKeyFor(fileKey))
    if (!raw) {
      return undefined
    }
    const parsed = JSON.parse(raw) as OcrCacheEntry
    if (!parsed || parsed.version !== CACHE_VERSION || parsed.fileKey !== fileKey || !Array.isArray(parsed.pages)) {
      return undefined
    }
    return parsed.pages
  } catch {
    return undefined
  }
}

/**
 * Persist an OCR result. Silently no-ops if storage is unavailable or the entry
 * is too large. Evicts the oldest entries when over `MAX_CACHE_ENTRIES`, and on
 * a quota error to make room. Returns whether the entry was written.
 */
export function writeOcrCache(fileKey: string, pages: OcrPageText[], storage = getDefaultStorage()): boolean {
  if (!storage) {
    return false
  }
  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0)
  if (totalChars > MAX_ENTRY_CHARS) {
    return false
  }

  const entry: OcrCacheEntry = {
    version: CACHE_VERSION,
    fileKey,
    storedAt: Date.now(),
    pages,
  }
  const serialized = JSON.stringify(entry)

  evictIfNeeded(storage, MAX_CACHE_ENTRIES - 1)

  try {
    storage.setItem(storageKeyFor(fileKey), serialized)
    return true
  } catch {
    // Likely a quota error — drop everything we own and retry once.
    evictIfNeeded(storage, 0)
    try {
      storage.setItem(storageKeyFor(fileKey), serialized)
      return true
    } catch {
      return false
    }
  }
}

/** Collect our cache entries (key + storedAt) currently in storage. */
function listCacheEntries(storage: OcrCacheStorage): Array<{ key: string; storedAt: number }> {
  const prefix = `${CACHE_PREFIX}:`
  const entries: Array<{ key: string; storedAt: number }> = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(prefix)) {
      continue
    }
    let storedAt = 0
    try {
      const raw = storage.getItem(key)
      if (raw) {
        storedAt = (JSON.parse(raw) as OcrCacheEntry).storedAt || 0
      }
    } catch {
      storedAt = 0
    }
    entries.push({ key, storedAt })
  }
  return entries
}

/** Evict oldest entries until at most `maxKeep` of our entries remain. */
function evictIfNeeded(storage: OcrCacheStorage, maxKeep: number): void {
  const entries = listCacheEntries(storage)
  if (entries.length <= maxKeep) {
    return
  }
  // Oldest first, so the slice we remove are the least-recently stored.
  entries.sort((a, b) => a.storedAt - b.storedAt)
  const toRemove = entries.length - Math.max(0, maxKeep)
  for (let i = 0; i < toRemove; i++) {
    try {
      storage.removeItem(entries[i].key)
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// Server-exposed configuration (the "server enable flag")
// ---------------------------------------------------------------------------

export type OcrServerConfig = {
  /** Whether the server operator has enabled the client-side OCR action. */
  enabled: boolean
  /** Default tesseract language code (e.g. "eng"). */
  defaultLanguage: string
}

/** Fallback language when the operator does not configure one. */
export const DEFAULT_OCR_LANGUAGE = 'eng'

/**
 * Read the OCR configuration the server injected into the page. The web app is
 * served as a static bundle whose `index.html` carries server-provided runtime
 * config as `window.*` globals (the same channel as `defaultSyncServer`,
 * `enabledUnfinishedFeatures`, etc.). The operator switch is the `OCR_ENABLED`
 * (and `OCR_DEFAULT_LANGUAGE`) env wired into those globals at container start —
 * see the app Docker entrypoint and docker-compose.
 *
 * Default is OFF: OCR downloads ~MBs of language data and is heavy, so an
 * operator must opt in.
 */
export function getOcrServerConfig(
  win: Partial<OcrWindow> = typeof window !== 'undefined' ? window : {},
): OcrServerConfig {
  const enabled = win.ocrEnabled === true
  const lang =
    typeof win.ocrDefaultLanguage === 'string' && win.ocrDefaultLanguage.trim().length > 0
      ? win.ocrDefaultLanguage.trim()
      : DEFAULT_OCR_LANGUAGE
  return { enabled, defaultLanguage: lang }
}

/** Shape of the OCR-related globals the server injects. */
export type OcrWindow = {
  ocrEnabled?: boolean
  ocrDefaultLanguage?: string
}

// ---------------------------------------------------------------------------
// Server-side OCR availability (OPT-IN, E2E downgrade)
// ---------------------------------------------------------------------------
//
// SERVER OCR is a SEPARATE, opt-in path from the browser OCR above. Browser OCR
// keeps everything on the device (still end-to-end encrypted). Server OCR uploads
// the DECRYPTED PDF page images to the server's /v1/ocr/recognize endpoint, which
// LEAVES end-to-end encryption — the server (and anyone controlling it) can read
// that content, exactly like the AI proxy. It is therefore gated by THREE layers:
//   1. operator env master switch  OCR_SERVER_ENABLED (server-side),
//   2. admin-manageable per-user   OCR_SERVER_ALLOWED  (server-side),
//   3. the client only offering it when the server reports BOTH satisfied.
//
// Unlike the browser flag (a static window global), availability is PER-USER, so
// it is fetched at runtime from the authenticated /v1/ocr/config endpoint rather
// than injected into the page.

/** Response shape of the server's GET /v1/ocr/config. */
export type ServerOcrConfigResponse = {
  /** Operator env master switch (OCR_SERVER_ENABLED). */
  serverOcrEnabled?: boolean
  /** Admin-managed per-user allow flag (OCR_SERVER_ALLOWED). */
  allowed?: boolean
  /** Convenience: true iff serverOcrEnabled AND allowed. */
  available?: boolean
  /** Server's default tesseract language (e.g. "eng"). */
  defaultLanguage?: string
}

export type ServerOcrConfig = {
  /** Whether the client may offer "Run OCR on server" for this user. */
  available: boolean
  /** Default tesseract language to request from the server. */
  defaultLanguage: string
}

/**
 * Normalize the /v1/ocr/config response into a client-usable config. Treats a
 * missing/garbage response as NOT available (fail closed — this is a privacy
 * downgrade, so we never offer it unless the server clearly says yes).
 */
export function parseServerOcrConfig(response: Partial<ServerOcrConfigResponse> | undefined): ServerOcrConfig {
  const available =
    response?.available === true || (response?.serverOcrEnabled === true && response?.allowed === true)
  const lang =
    typeof response?.defaultLanguage === 'string' && response.defaultLanguage.trim().length > 0
      ? response.defaultLanguage.trim()
      : DEFAULT_OCR_LANGUAGE
  return { available, defaultLanguage: lang }
}
