import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Spinner from '@/Components/Spinner/Spinner'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { copyTextToClipboard } from '@/Utils/copyTextToClipboard'
import { formatPdfDeepLink, PdfDeepLinkTarget } from './PdfDeepLink'
import { getPdfjs, PDFDocumentProxy, PDFPageProxy } from './pdfjs'
import { findMatchesAcrossPages, joinTextItems, PdfPageText, PdfSearchMatch, wrapMatchIndex } from './pdfSearch'
import {
  buildOcrFileKey,
  getOcrServerConfig,
  joinPageTexts,
  mergeOcrWithEmbedded,
  OcrPageText,
  readOcrCache,
  writeOcrCache,
} from './pdfOcr'
import type { OcrProgress } from './runPdfOcr'

type Props = {
  bytes: Uint8Array
  /** FileItem uuid, used to build a shareable deep link. */
  fileUuid?: string
  /** FileItem remoteIdentifier — part of the OCR cache key (changes on edit). */
  fileRemoteIdentifier?: string
  /** Optional location to scroll/highlight on open. */
  target?: PdfDeepLinkTarget
}

/** Phases of the client-side OCR action. */
type OcrStatus = 'idle' | 'running' | 'done' | 'error'

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 0.2
/** Debounce (ms) before a typed query is committed and matches recomputed. */
const SEARCH_DEBOUNCE_MS = 250

/**
 * Renders a single PDF page (canvas + selectable text layer) once it scrolls
 * near the viewport. Pages that are far away render a sized placeholder so the
 * scroll height is correct without paying the render cost (lazy rendering).
 */
const PdfPage: FunctionComponent<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjs: any
  page: PDFPageProxy
  pageNumber: number
  scale: number
  searchQuery: string
  matchCase: boolean
  isActiveMatchPage: boolean
  registerContainer: (pageNumber: number, el: HTMLElement | null) => void
}> = ({ pdfjs, page, pageNumber, scale, searchQuery, matchCase, isActiveMatchPage, registerContainer }) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isRendered, setIsRendered] = useState(false)

  const baseViewport = useMemo(() => page.getViewport({ scale }), [page, scale])

  // Observe visibility so we only render pages near the viewport.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) {
      return
    }
    const scrollParent = wrapper.closest('[data-pdf-scroll-container]')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true)
          }
        }
      },
      { root: scrollParent instanceof HTMLElement ? scrollParent : null, rootMargin: '800px 0px' },
    )
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    registerContainer(pageNumber, wrapperRef.current)
    return () => registerContainer(pageNumber, null)
  }, [pageNumber, registerContainer])

  // Render canvas + text layer when visible / scale changes.
  useEffect(() => {
    if (!isVisible) {
      return
    }
    let cancelled = false
    let renderTask: { cancel: () => void } | undefined
    let textLayer: { cancel: () => void } | undefined

    const render = async () => {
      const canvas = canvasRef.current
      const textLayerDiv = textLayerRef.current
      if (!canvas || !textLayerDiv) {
        return
      }

      const outputScale = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale })
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`

      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      try {
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        await (renderTask as unknown as { promise: Promise<void> }).promise

        if (cancelled) {
          return
        }

        // Text layer for selection + search highlighting.
        textLayerDiv.replaceChildren()
        textLayerDiv.style.setProperty('--scale-factor', `${scale}`)
        textLayerDiv.style.width = `${Math.floor(viewport.width)}px`
        textLayerDiv.style.height = `${Math.floor(viewport.height)}px`

        const textContentSource = page.streamTextContent({ includeMarkedContent: true })
        textLayer = new pdfjs.TextLayer({
          textContentSource,
          container: textLayerDiv,
          viewport,
        })
        await (textLayer as unknown as { render: () => Promise<void> }).render()

        if (!cancelled) {
          setIsRendered(true)
        }
      } catch (error) {
        // RenderingCancelledException is expected on rapid scale changes.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.debug('PDF page render interrupted', error)
        }
      }
    }

    void render()

    return () => {
      cancelled = true
      try {
        renderTask?.cancel()
      } catch {
        /* noop */
      }
      try {
        textLayer?.cancel()
      } catch {
        /* noop */
      }
    }
  }, [isVisible, page, scale, pdfjs])

  // Highlight search matches inside the rendered text layer.
  useEffect(() => {
    const textLayerDiv = textLayerRef.current
    if (!textLayerDiv || !isRendered) {
      return
    }

    const spans = Array.from(textLayerDiv.querySelectorAll('span'))
    const rawQuery = searchQuery.trim()
    const query = matchCase ? rawQuery : rawQuery.toLowerCase()

    let firstMatch: HTMLElement | undefined
    for (const span of spans) {
      const spanText = span.textContent || ''
      const text = matchCase ? spanText : spanText.toLowerCase()
      const matched = query.length > 0 && text.includes(query)
      span.classList.toggle('pdf-search-highlight', matched)
      span.classList.toggle('pdf-search-highlight-active', matched && isActiveMatchPage)
      if (matched && !firstMatch) {
        firstMatch = span
      }
    }

    if (isActiveMatchPage && firstMatch) {
      firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [searchQuery, matchCase, isRendered, isActiveMatchPage])

  return (
    <div
      ref={wrapperRef}
      data-pdf-page={pageNumber}
      className="relative mx-auto my-2 bg-white shadow-md"
      style={{ width: `${Math.floor(baseViewport.width)}px`, height: `${Math.floor(baseViewport.height)}px` }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer pdf-text-layer absolute left-0 top-0 overflow-hidden opacity-100" />
      {!isRendered && (
        <div className="absolute inset-0 flex items-center justify-center text-passive-1">
          <Spinner className="h-5 w-5" />
        </div>
      )}
    </div>
  )
}

const PdfPreview: FunctionComponent<Props> = ({ bytes, fileUuid, fileRemoteIdentifier, target }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pdfjs, setPdfjs] = useState<any>()
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [pages, setPages] = useState<PDFPageProxy[]>([])
  const [loadError, setLoadError] = useState(false)
  const [scale, setScale] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [matches, setMatches] = useState<PdfSearchMatch[]>([])
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)

  // --- OCR (client-side, gated by a server-exposed flag) -------------------
  // Files are end-to-end encrypted, so OCR cannot run on the server. The server
  // only exposes an enable flag + default language (read here); the actual OCR
  // runs in the browser on the already-decrypted page canvases.
  const ocrConfig = useMemo(() => getOcrServerConfig(), [])
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>('idle')
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | undefined>()
  const [ocrError, setOcrError] = useState<string | undefined>()
  /** Per-page extracted text (embedded + OCR merged) once OCR has run. */
  const [extractedPages, setExtractedPages] = useState<OcrPageText[] | undefined>()
  /** True when `extractedPages` came straight from cache (no OCR run needed). */
  const [ocrFromCache, setOcrFromCache] = useState(false)
  const ocrAbortRef = useRef<AbortController | undefined>(undefined)

  const ocrCacheKey = useMemo(
    () => (fileUuid ? buildOcrFileKey(fileUuid, fileRemoteIdentifier) : undefined),
    [fileUuid, fileRemoteIdentifier],
  )

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pageContainers = useRef<Map<number, HTMLElement>>(new Map())
  const didApplyInitialTarget = useRef(false)

  const registerContainer = useCallback((pageNumber: number, el: HTMLElement | null) => {
    if (el) {
      pageContainers.current.set(pageNumber, el)
    } else {
      pageContainers.current.delete(pageNumber)
    }
  }, [])

  // Load the PDF document (pdfjs is dynamically imported -> code-split).
  useEffect(() => {
    let cancelled = false
    let loadingTask: { destroy: () => void } | undefined

    const load = async () => {
      try {
        const lib = getPdfjs()
        if (cancelled) {
          return
        }
        setPdfjs(lib)
        // Clone bytes so pdf.js can transfer the buffer to the worker without
        // detaching the caller's Uint8Array (which other previews may reuse).
        const data = bytes.slice(0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        loadingTask = (lib as any).getDocument({ data })
        const document = await (loadingTask as unknown as { promise: Promise<PDFDocumentProxy> }).promise
        if (cancelled) {
          return
        }
        setPdf(document)

        const loadedPages: PDFPageProxy[] = []
        for (let i = 1; i <= document.numPages; i++) {
          loadedPages.push(await document.getPage(i))
          if (cancelled) {
            return
          }
        }
        setPages(loadedPages)
      } catch (error) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error('Failed to load PDF', error)
          setLoadError(true)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      try {
        loadingTask?.destroy()
      } catch {
        /* noop */
      }
    }
  }, [bytes])

  // Cleanup document on unmount.
  useEffect(() => {
    return () => {
      try {
        void pdf?.destroy()
      } catch {
        /* noop */
      }
    }
  }, [pdf])

  const numPages = pdf?.numPages ?? 0

  const scrollToPage = useCallback((pageNumber: number) => {
    const el = pageContainers.current.get(pageNumber)
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [])

  // Apply an incoming deep-link target once pages are ready.
  useEffect(() => {
    if (didApplyInitialTarget.current || pages.length === 0 || !target) {
      return
    }
    didApplyInitialTarget.current = true

    if (target.page && target.page >= 1 && target.page <= pages.length) {
      setCurrentPage(target.page)
      setPageInput(String(target.page))
      // Wait a tick for placeholders to mount before scrolling.
      window.setTimeout(() => scrollToPage(target.page as number), 50)
    }
    if (target.quote) {
      setShowSearch(true)
      setSearchQuery(target.quote)
      setCommittedQuery(target.quote)
    }
  }, [pages, target, scrollToPage])

  // Track which page is currently centered for the page-number indicator.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || pages.length === 0) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) {
          const pageNumber = Number(visible.target.getAttribute('data-pdf-page'))
          if (pageNumber) {
            setCurrentPage(pageNumber)
            setPageInput(String(pageNumber))
          }
        }
      },
      { root: container, threshold: [0.25, 0.5, 0.75] },
    )
    pageContainers.current.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [pages])

  // Debounce typed input -> committed query so we don't re-scan the whole
  // document on every keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setCommittedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchQuery])

  // Compute search matches across all pages when the committed query (or the
  // match-case toggle) changes. Page text is extracted lazily here, not on load.
  useEffect(() => {
    let cancelled = false
    const query = committedQuery.trim()
    if (!query || pages.length === 0) {
      setMatches([])
      setActiveMatchIndex(0)
      return
    }

    const run = async () => {
      let pageTexts: PdfPageText[]
      if (extractedPages) {
        // OCR has run: search the merged (embedded + OCR) text so image-only
        // pages are searchable too.
        pageTexts = extractedPages.map((p) => ({ pageNumber: p.pageNumber, text: p.text }))
      } else {
        pageTexts = []
        for (const page of pages) {
          const content = await page.getTextContent()
          if (cancelled) {
            return
          }
          pageTexts.push({ pageNumber: page.pageNumber, text: joinTextItems(content.items) })
        }
      }
      const found = findMatchesAcrossPages(pageTexts, query, matchCase)
      if (!cancelled) {
        setMatches(found)
        setActiveMatchIndex(0)
        if (found[0]) {
          scrollToPage(found[0].pageNumber)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [committedQuery, matchCase, pages, scrollToPage, extractedPages])

  // Load any cached OCR result for this file as soon as the file key is known,
  // so reopening a previously-OCR'd file is instant (never re-OCR unchanged
  // files). A cache miss leaves the action available to run.
  useEffect(() => {
    if (!ocrCacheKey) {
      return
    }
    const cached = readOcrCache(ocrCacheKey)
    if (cached && cached.length > 0) {
      setExtractedPages(cached)
      setOcrFromCache(true)
      setOcrStatus('done')
    }
  }, [ocrCacheKey])

  // Cancel any in-flight OCR on unmount.
  useEffect(() => {
    return () => {
      ocrAbortRef.current?.abort()
    }
  }, [])

  const runOcr = useCallback(async () => {
    if (pages.length === 0 || ocrStatus === 'running') {
      return
    }
    setOcrStatus('running')
    setOcrError(undefined)
    setOcrProgress({ totalPages: 0, completedPages: 0, pageProgress: 0 })

    const controller = new AbortController()
    ocrAbortRef.current = controller

    try {
      // Lazy-load the heavy OCR runner (tesseract.js) so it is code-split out of
      // the main bundle and only fetched when the user actually requests OCR.
      const { runPdfOcr } = await import('./runPdfOcr')
      const { embedded, ocr } = await runPdfOcr({
        pages,
        language: ocrConfig.defaultLanguage,
        onProgress: setOcrProgress,
        signal: controller.signal,
      })
      const merged = mergeOcrWithEmbedded(embedded, ocr)
      setExtractedPages(merged)
      setOcrFromCache(false)
      setOcrStatus('done')
      if (ocrCacheKey) {
        writeOcrCache(ocrCacheKey, merged)
      }
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        setOcrStatus('idle')
        return
      }
      // eslint-disable-next-line no-console
      console.error('PDF OCR failed', error)
      setOcrError('OCR failed. The language data may have failed to download.')
      setOcrStatus('error')
    } finally {
      ocrAbortRef.current = undefined
    }
  }, [pages, ocrStatus, ocrConfig.defaultLanguage, ocrCacheKey])

  const cancelOcr = useCallback(() => {
    ocrAbortRef.current?.abort()
  }, [])

  const copyExtractedText = useCallback(() => {
    if (!extractedPages) {
      return
    }
    const text = joinPageTexts(extractedPages)
    if (text.length > 0) {
      copyTextToClipboard(text, 'Copied extracted text')
    }
  }, [extractedPages])

  const activeMatchPage = matches[activeMatchIndex]?.pageNumber

  const goToMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) {
        return
      }
      const next = wrapMatchIndex(activeMatchIndex, delta, matches.length)
      setActiveMatchIndex(next)
      scrollToPage(matches[next].pageNumber)
    },
    [matches, activeMatchIndex, scrollToPage],
  )

  const openSearch = useCallback(() => {
    setShowSearch(true)
    // Focus the input on the next tick (after it mounts / re-renders).
    window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, 0)
  }, [])

  const closeSearch = useCallback(() => {
    setShowSearch(false)
    setSearchQuery('')
    setCommittedQuery('')
  }, [])

  // Ctrl/Cmd+F opens (or re-focuses) the in-document find bar. The listener is
  // scoped to the PDF view's root, so it does not hijack the global app find
  // shortcut anywhere else. We only preventDefault when actually inside the PDF.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
        return
      }
      if (event.key === 'Escape' && showSearch) {
        // Let Escape close the find bar without bubbling to the modal's own
        // Escape-to-dismiss handler.
        event.stopPropagation()
        closeSearch()
      }
    },
    [openSearch, closeSearch, showSearch],
  )

  const zoomIn = () => setScale((s) => Math.min(MAX_SCALE, Math.round((s + SCALE_STEP) * 100) / 100))
  const zoomOut = () => setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 100) / 100))

  const fitWidth = useCallback(() => {
    const container = scrollContainerRef.current
    const firstPage = pages[0]
    if (!container || !firstPage) {
      return
    }
    const viewport = firstPage.getViewport({ scale: 1 })
    const available = container.clientWidth - 32
    if (viewport.width > 0 && available > 0) {
      setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / viewport.width)))
    }
  }, [pages])

  const commitPageInput = useCallback(() => {
    const value = parseInt(pageInput, 10)
    if (Number.isFinite(value) && value >= 1 && value <= numPages) {
      setCurrentPage(value)
      scrollToPage(value)
    } else {
      setPageInput(String(currentPage))
    }
  }, [pageInput, numPages, currentPage, scrollToPage])

  const goToPage = useCallback(
    (pageNumber: number) => {
      const clamped = Math.min(Math.max(pageNumber, 1), numPages)
      setCurrentPage(clamped)
      setPageInput(String(clamped))
      scrollToPage(clamped)
    },
    [numPages, scrollToPage],
  )

  const copyPageLink = useCallback(() => {
    if (!fileUuid) {
      return
    }
    const link = formatPdfDeepLink(fileUuid, { page: currentPage })
    copyTextToClipboard(link, `Copied link to page ${currentPage}`)
  }, [fileUuid, currentPage])

  const copyQuoteLink = useCallback(() => {
    if (!fileUuid) {
      return
    }
    const selection = window.getSelection()?.toString().trim()
    if (!selection) {
      return
    }
    const link = formatPdfDeepLink(fileUuid, { page: currentPage, quote: selection })
    copyTextToClipboard(link, 'Copied link to selected text')
  }, [fileUuid, currentPage])

  if (loadError) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center p-4 text-center">
        <Icon type="file-pdf" size="large" className="mb-3 text-passive-1" />
        <div className="text-base font-bold">Unable to render this PDF.</div>
        <p className="mt-1 max-w-[40ch] text-sm text-passive-0">The file may be corrupted or password-protected.</p>
      </div>
    )
  }

  if (!pdfjs || pages.length === 0) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <Spinner className="h-6 w-6" />
        <span className="mt-3 text-sm text-passive-0">Loading PDF...</span>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col" onKeyDown={handleKeyDown}>
      {/* Toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-border bg-default px-2 py-1.5">
        <div className="flex items-center gap-1">
          <StyledTooltip label="Previous page" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="Previous page"
            >
              <Icon type="chevron-left" className="text-neutral" />
            </button>
          </StyledTooltip>
          <div className="flex items-center text-sm text-neutral">
            <input
              className="w-10 rounded border border-border bg-default px-1 py-0.5 text-center text-sm text-text"
              value={pageInput}
              inputMode="numeric"
              aria-label="Page number"
              onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitPageInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitPageInput()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            <span className="mx-1 whitespace-nowrap text-passive-1">/ {numPages}</span>
          </div>
          <StyledTooltip label="Next page" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= numPages}
              aria-label="Next page"
            >
              <Icon type="chevron-right" className="text-neutral" />
            </button>
          </StyledTooltip>
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        <div className="flex items-center gap-1">
          <StyledTooltip label="Zoom out" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              aria-label="Zoom out"
            >
              <Icon type="subtract" className="text-neutral" />
            </button>
          </StyledTooltip>
          <span className="w-12 text-center text-sm text-passive-1">{Math.round(scale * 100)}%</span>
          <StyledTooltip label="Zoom in" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              <Icon type="add" className="text-neutral" />
            </button>
          </StyledTooltip>
          <StyledTooltip label="Fit width" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
              onClick={fitWidth}
              aria-label="Fit width"
            >
              <Icon type="arrows-vertical" className="rotate-90 text-neutral" />
            </button>
          </StyledTooltip>
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        <div className="flex items-center gap-1">
          <StyledTooltip label="Search in document (Ctrl/Cmd+F)" className="!z-modal">
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
              onClick={() => (showSearch ? closeSearch() : openSearch())}
              aria-label="Search in document"
            >
              <Icon type="search" className="text-neutral" />
            </button>
          </StyledTooltip>
          {fileUuid && (
            <>
              <StyledTooltip label={`Copy link to page ${currentPage}`} className="!z-modal">
                <button
                  className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
                  onClick={copyPageLink}
                  aria-label="Copy link to this page"
                >
                  <Icon type="link" className="text-neutral" />
                </button>
              </StyledTooltip>
              <StyledTooltip label="Copy link to selected text" className="!z-modal">
                <button
                  className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
                  onClick={copyQuoteLink}
                  aria-label="Copy link to selected text"
                >
                  <Icon type="copy" className="text-neutral" />
                </button>
              </StyledTooltip>
            </>
          )}
        </div>

        {/* Client-side OCR (only when the server operator has enabled it). */}
        {ocrConfig.enabled && (
          <>
            <div className="mx-1 h-5 w-px bg-border" />
            <div className="flex items-center gap-1">
              {ocrStatus === 'running' ? (
                <div className="flex items-center gap-2 px-1">
                  <Spinner className="h-4 w-4" />
                  <span className="whitespace-nowrap text-xs text-passive-1">
                    {ocrProgress && ocrProgress.totalPages > 0
                      ? `OCR page ${ocrProgress.completedPages + (ocrProgress.pageProgress < 1 ? 1 : 0)} / ${
                          ocrProgress.totalPages
                        } (${Math.round(ocrProgress.pageProgress * 100)}%)`
                      : 'Preparing OCR...'}
                  </span>
                  <button
                    className="flex cursor-pointer rounded border-0 bg-transparent p-1 hover:bg-contrast"
                    onClick={cancelOcr}
                    aria-label="Cancel OCR"
                  >
                    <Icon type="close" className="text-neutral" size="small" />
                  </button>
                </div>
              ) : (
                <StyledTooltip
                  label={
                    ocrStatus === 'done'
                      ? ocrFromCache
                        ? 'Text already extracted (cached). Re-run OCR.'
                        : 'Text extracted. Re-run OCR.'
                      : 'Extract text from scanned pages with OCR. Runs in your browser (slow; downloads language data).'
                  }
                  className="!z-modal"
                >
                  <button
                    className="flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-2 py-1.5 text-sm text-neutral hover:bg-contrast"
                    onClick={runOcr}
                    aria-label="Extract text with OCR"
                  >
                    <Icon type="plain-text" className="text-neutral" />
                    <span className="whitespace-nowrap">
                      {ocrStatus === 'done' ? 'Re-run OCR' : 'Extract text (OCR)'}
                    </span>
                  </button>
                </StyledTooltip>
              )}
              {ocrStatus === 'done' && extractedPages && (
                <StyledTooltip label="Copy all extracted text" className="!z-modal">
                  <button
                    className="flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
                    onClick={copyExtractedText}
                    aria-label="Copy extracted text"
                  >
                    <Icon type="copy" className="text-neutral" />
                  </button>
                </StyledTooltip>
              )}
              {ocrStatus === 'error' && ocrError && (
                <span className="whitespace-nowrap text-xs text-danger">{ocrError}</span>
              )}
            </div>
          </>
        )}

        {showSearch && (
          <div className="ml-auto flex items-center gap-1">
            <input
              ref={searchInputRef}
              className="w-40 rounded border border-border bg-default px-2 py-0.5 text-sm text-text"
              placeholder="Find in document"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Commit immediately (skip the debounce) and jump to next match.
                  if (committedQuery === searchQuery && matches.length > 0) {
                    goToMatch(e.shiftKey ? -1 : 1)
                  } else {
                    setCommittedQuery(searchQuery)
                  }
                }
              }}
            />
            <StyledTooltip label="Match case" className="!z-modal">
              <button
                className={`flex cursor-pointer rounded border-0 p-1 text-sm font-bold ${
                  matchCase ? 'bg-info text-info-contrast' : 'bg-transparent text-neutral hover:bg-contrast'
                }`}
                onClick={() => setMatchCase((m) => !m)}
                aria-label="Match case"
                aria-pressed={matchCase}
              >
                Aa
              </button>
            </StyledTooltip>
            <span className="min-w-[4.5rem] text-center text-xs text-passive-1">
              {committedQuery
                ? matches.length === 0
                  ? 'No results'
                  : `${activeMatchIndex + 1} of ${matches.length}`
                : ''}
            </span>
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1 hover:bg-contrast disabled:opacity-40"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              aria-label="Previous match"
            >
              <Icon type="chevron-up" className="text-neutral" size="small" />
            </button>
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1 hover:bg-contrast disabled:opacity-40"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              aria-label="Next match"
            >
              <Icon type="chevron-down" className="text-neutral" size="small" />
            </button>
            <button
              className="flex cursor-pointer rounded border-0 bg-transparent p-1 hover:bg-contrast"
              onClick={closeSearch}
              aria-label="Close search"
            >
              <Icon type="close" className="text-neutral" size="small" />
            </button>
          </div>
        )}
      </div>

      {/* Honest OCR caveat banner: client-side, slow, downloads data, varies. */}
      {ocrConfig.enabled && (ocrStatus === 'running' || (ocrStatus === 'done' && !ocrFromCache)) && (
        <div className="flex-shrink-0 border-b border-border bg-warning-faded px-3 py-1.5 text-xs text-warning">
          {ocrStatus === 'running'
            ? 'OCR runs in your browser on this device (your files stay end-to-end encrypted). It is slow and downloads language data on first use.'
            : 'OCR finished. Accuracy varies with scan quality; extracted text is now searchable and copyable, and is cached on this device.'}
        </div>
      )}

      {/* Pages */}
      <div ref={scrollContainerRef} data-pdf-scroll-container className="flex-grow overflow-auto bg-passive-5 p-2">
        {pages.map((page, index) => (
          <PdfPage
            key={index}
            pdfjs={pdfjs}
            page={page}
            pageNumber={index + 1}
            scale={scale}
            searchQuery={committedQuery}
            matchCase={matchCase}
            isActiveMatchPage={activeMatchPage === index + 1}
            registerContainer={registerContainer}
          />
        ))}
      </div>
    </div>
  )
}

export default PdfPreview
