import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { applyPrintLayout, PRINT_BODY_ID, removePrintLayout } from '@/Components/SuperEditor/Layout/applyPrintLayout'
import { getPrintableDataTable } from '@/Components/SuperEditor/Lexical/Nodes/PrintableDataTableRegistry'
import { getPrintableCalendar } from '@/Components/SuperEditor/Lexical/Nodes/PrintableCalendarRegistry'
import { NoteType } from '@standardnotes/snjs'

export const PRINT_ROOT_ID = 'srn-print-root'
export const PRINT_TITLE_ID = 'srn-print-title'
export const PRINTING_BODY_CLASS = 'srn-printing'
export const PRINT_NOTE_UUID_ATTRIBUTE = 'data-srn-note-uuid'
export const PRINT_EMPTY_ATTRIBUTE = 'data-srn-print-empty'

const PRINT_FALLBACK_CLEANUP_MS = 60_000
let activePrintCleanup: (() => void) | undefined

type PrintNoteOptions = {
  noteUuid?: string
  fallbackTitle?: string
  /** Complete decrypted note text used only after its persisted format is proven printable. */
  fallbackBody?: string
  fallbackNoteType?: NoteType
  /** Distinguishes legacy plain notes (no type or editor) from unknown custom formats. */
  fallbackEditorIdentifier?: string
}

type PrintBodySource =
  | { kind: 'super'; element: HTMLElement }
  | { kind: 'plain'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'markdown-preview'; element: HTMLElement }
  | { kind: 'fallback'; text: string }

export type ActiveNotePrintSupport =
  { supported: true; source: PrintBodySource['kind'] } | { supported: false; reason: string }

type ResolvedPrintSource = {
  titleText: string
  body: PrintBodySource
}

const unsupportedPrintReason = 'This editor cannot provide a safe title-and-body print view.'

const plaintextFallbackNoteTypes = new Set<NoteType>([NoteType.Plain, NoteType.Markdown, NoteType.Code])

/**
 * Return persisted text only for formats whose storage is the note body itself.
 * Super and custom formats fail closed: their complete semantic document model
 * is available only from a live editor, and their serialized storage must never
 * be handed to the print compositor as if it were prose.
 */
function projectPersistedPrintBody(options: PrintNoteOptions): string | undefined {
  if (options.fallbackBody === undefined) {
    return undefined
  }

  if (options.fallbackNoteType && plaintextFallbackNoteTypes.has(options.fallbackNoteType)) {
    return options.fallbackBody
  }

  // Notes created before noteType existed are plain only when they also lack a
  // custom editor identifier. Unknown/custom formats remain unsupported.
  if (!options.fallbackNoteType && !options.fallbackEditorIdentifier) {
    return options.fallbackBody
  }

  return undefined
}

/** Copy live form state before the clone is sanitized into static print text. */
function copyLiveControlState(source: HTMLElement, clone: HTMLElement): void {
  const sourceControls = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  )
  const clonedControls = clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  )

  sourceControls.forEach((sourceControl, index) => {
    const clonedControl = clonedControls[index]
    if (!clonedControl) {
      return
    }
    clonedControl.value = sourceControl.value
    if (sourceControl instanceof HTMLInputElement && clonedControl instanceof HTMLInputElement) {
      clonedControl.checked = sourceControl.checked
    }
  })
}

/** Canvas pixels are not copied by cloneNode, so freeze each one as an image. */
function copyCanvasPixels(source: HTMLElement, clone: HTMLElement): void {
  const sourceCanvases = source.querySelectorAll('canvas')
  const clonedCanvases = clone.querySelectorAll('canvas')

  sourceCanvases.forEach((sourceCanvas, index) => {
    const clonedCanvas = clonedCanvases[index]
    if (!clonedCanvas) {
      return
    }
    try {
      const image = source.ownerDocument.createElement('img')
      image.src = sourceCanvas.toDataURL('image/png')
      image.alt = sourceCanvas.getAttribute('aria-label') ?? 'Document drawing'
      image.width = sourceCanvas.width
      image.height = sourceCanvas.height
      clonedCanvas.replaceWith(image)
    } catch {
      // A cross-origin/tainted canvas cannot be serialized. It is removed by the
      // sanitizer below rather than risking a blank interactive canvas in print.
    }
  })
}

const replaceWithStaticValue = (control: HTMLInputElement | HTMLTextAreaElement): void => {
  const document = control.ownerDocument

  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    const marker = document.createElement('span')
    marker.className = 'srn-print-checkbox'
    marker.setAttribute('role', 'img')
    marker.setAttribute('aria-label', control.checked ? 'Checked' : 'Unchecked')
    marker.textContent = control.checked ? '☒' : '☐'
    control.replaceWith(marker)
    return
  }

  const type = control instanceof HTMLInputElement ? control.type.toLowerCase() : 'textarea'
  const controlHint = `${control.getAttribute('placeholder') ?? ''} ${control.getAttribute('aria-label') ?? ''}`
    .trim()
    .toLowerCase()
  if (control instanceof HTMLInputElement && /\b(search|filter|find|add)\b/.test(controlHint)) {
    control.remove()
    return
  }

  const textBearingTypes = new Set(['text', 'url', 'email', 'tel', 'number', 'textarea'])
  if (textBearingTypes.has(type) && control.value.length > 0) {
    const value = document.createElement(control instanceof HTMLTextAreaElement ? 'pre' : 'span')
    value.className = 'srn-print-control-value'
    value.textContent = control.value
    control.replaceWith(value)
    return
  }

  control.remove()
}

/**
 * Reduce a live editor clone to document content. This is deliberately a DOM
 * mutation, not merely print CSS: forbidden controls are absent from the tree
 * handed to the browser's print compositor, so a new widget style cannot make
 * a toolbar or an "Add" action reappear on paper.
 */
export function sanitizePrintBody(body: HTMLElement, sourceBody?: HTMLElement): HTMLElement {
  // Folding is session-local presentation state, not document content. Restore
  // folded descendants and remove the injected disclosure/ellipsis chrome in
  // the detached clone only; the live editor remains collapsed.
  body.querySelectorAll<HTMLElement>('[data-fold-toggle], .Lexical__foldToggle').forEach((toggle) => toggle.remove())
  body
    .querySelectorAll<HTMLElement>('.Lexical__folded, .Lexical__foldCollapsed, .Lexical__foldable')
    .forEach((element) => {
      element.classList.remove('Lexical__folded', 'Lexical__foldCollapsed', 'Lexical__foldable', 'hidden')
      element.removeAttribute('data-fold-key')
      element.removeAttribute('hidden')
      element.removeAttribute('aria-hidden')
      if (element.style.display === 'none') {
        element.style.removeProperty('display')
      }
    })

  // Super DataTables render only the current page on screen. Their dedicated
  // semantic projection contains every underlying row and no controls. Replace
  // the entire interactive widget before the general control sanitizer runs.
  const sourceDataTables = sourceBody?.querySelectorAll<HTMLElement>('[data-datatable-block="true"]') ?? []
  body.querySelectorAll<HTMLElement>('[data-datatable-block="true"]').forEach((dataTable, index) => {
    const sourceDataTable = sourceDataTables[index]
    const printableData = sourceDataTable ? getPrintableDataTable(sourceDataTable) : undefined
    if (!printableData) {
      dataTable.remove()
      return
    }

    const table = body.ownerDocument.createElement('table')
    table.setAttribute('data-srn-print-datatable', 'true')
    const tableHead = table.createTHead()
    const headerRow = tableHead.insertRow()
    printableData.columns.forEach((column) => {
      const cell = body.ownerDocument.createElement('th')
      cell.scope = 'col'
      cell.textContent = column
      headerRow.appendChild(cell)
    })
    const tableBody = table.createTBody()
    printableData.rows.forEach((row) => {
      const tableRow = tableBody.insertRow()
      row.forEach((value) => {
        const cell = tableRow.insertCell()
        cell.textContent = value
      })
    })
    dataTable.replaceWith(table)
  })

  // Calendar blocks expose only one selected day in their interactive DOM.
  // Replace each with its explicitly registered all-event semantic model.
  const sourceCalendars = sourceBody?.querySelectorAll<HTMLElement>('[data-calendar-block="true"]') ?? []
  body.querySelectorAll<HTMLElement>('[data-calendar-block="true"]').forEach((calendar, index) => {
    const sourceCalendar = sourceCalendars[index]
    const printableCalendar = sourceCalendar ? getPrintableCalendar(sourceCalendar) : undefined
    if (!printableCalendar) {
      calendar.remove()
      return
    }

    const table = body.ownerDocument.createElement('table')
    table.setAttribute('data-srn-print-calendar', 'true')
    const tableHead = table.createTHead()
    const headerRow = tableHead.insertRow()
    for (const heading of ['Date', 'Event']) {
      const cell = body.ownerDocument.createElement('th')
      cell.scope = 'col'
      cell.textContent = heading
      headerRow.appendChild(cell)
    }
    const tableBody = table.createTBody()
    printableCalendar.events.forEach((event) => {
      const row = tableBody.insertRow()
      const date = row.insertCell()
      date.textContent = event.date
      const text = row.insertCell()
      text.textContent = event.text
    })
    calendar.replaceWith(table)
  })

  body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(replaceWithStaticValue)

  body
    .querySelectorAll(
      [
        'button',
        'select',
        'script',
        'style',
        'link',
        'meta',
        'iframe',
        'object',
        'embed',
        'video',
        'audio',
        'canvas',
        '[role="button"]',
        '[role="menu"]',
        '[role="menubar"]',
        '[role="toolbar"]',
        '[role="dialog"]',
        '[role="tooltip"]',
        '[aria-haspopup]',
        '[data-srn-print-exclude]',
        '[data-radix-popper-content-wrapper]',
        '.draggable-block-menu',
        '.search-highlight-container',
      ].join(','),
    )
    .forEach((element) => element.remove())

  body.querySelectorAll<HTMLElement>('*').forEach((element) => {
    const className = typeof element.className === 'string' ? element.className.toLowerCase() : ''
    if (
      className.includes('placeholder') ||
      className.includes('image-resizer') ||
      className.includes('table-cell-action') ||
      className.includes('attachment-toolbar')
    ) {
      element.remove()
      return
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || ['contenteditable', 'spellcheck', 'tabindex', 'draggable'].includes(name)) {
        element.removeAttribute(attribute.name)
      }
    }

    if (element instanceof HTMLAnchorElement && /^\s*javascript:/i.test(element.getAttribute('href') ?? '')) {
      element.removeAttribute('href')
    }
  })

  // The source stays mounted while the print dialog is open. Duplicated ids can
  // make CSS or internal anchors resolve back into the live editor, so only the
  // dedicated snapshot ids survive.
  body.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  body.removeAttribute('contenteditable')
  body.removeAttribute('spellcheck')
  body.removeAttribute('tabindex')
  body.id = PRINT_BODY_ID

  return body
}

function resolvePrintSource(targetDocument: Document, options: PrintNoteOptions): ResolvedPrintSource | undefined {
  const title = targetDocument.getElementById(ElementIds.NoteTitleEditor)
  const liveTitle = title instanceof HTMLInputElement ? title : undefined
  const liveNoteUuid = liveTitle?.getAttribute(PRINT_NOTE_UUID_ATTRIBUTE) ?? undefined
  const requestedNoteIsActive = !options.noteUuid || options.noteUuid === liveNoteUuid

  // Context menus can target a note other than the one open in the editor.
  // Never mix that active note's live DOM with the selected note: use the
  // selected note's persisted title and a type-aware body projection as an
  // atomic pair. Unsupported structured formats fail closed.
  if (!requestedNoteIsActive || !liveTitle) {
    const persistedBody = projectPersistedPrintBody(options)
    if (options.fallbackTitle !== undefined && persistedBody !== undefined) {
      return { titleText: options.fallbackTitle, body: { kind: 'fallback', text: persistedBody } }
    }
    return undefined
  }

  const superEditor = targetDocument.getElementById(SuperEditorContentId)
  if (superEditor instanceof HTMLElement) {
    return { titleText: liveTitle.value, body: { kind: 'super', element: superEditor } }
  }

  const plainEditor = targetDocument.getElementById(ElementIds.NoteTextEditor)
  if (plainEditor instanceof HTMLTextAreaElement || plainEditor instanceof HTMLInputElement) {
    return { titleText: liveTitle.value, body: { kind: 'plain', element: plainEditor } }
  }

  const markdownPreview = targetDocument.querySelector<HTMLElement>(`#${ElementIds.EditorContent} .markdown-preview`)
  if (markdownPreview) {
    return { titleText: liveTitle.value, body: { kind: 'markdown-preview', element: markdownPreview } }
  }

  const persistedBody = projectPersistedPrintBody(options)
  if (persistedBody !== undefined) {
    return { titleText: liveTitle.value, body: { kind: 'fallback', text: persistedBody } }
  }

  return undefined
}

export function getActiveNotePrintSupport(
  options: PrintNoteOptions = {},
  targetDocument: Document | undefined = typeof document === 'undefined' ? undefined : document,
): ActiveNotePrintSupport {
  if (!targetDocument) {
    return { supported: false, reason: 'Printing is unavailable outside the browser.' }
  }

  const source = resolvePrintSource(targetDocument, options)
  if (source) {
    return { supported: true, source: source.body.kind }
  }

  const title = targetDocument.getElementById(ElementIds.NoteTitleEditor)
  if (!(title instanceof HTMLInputElement)) {
    return { supported: false, reason: 'Open a note before printing.' }
  }
  if (options.noteUuid && title.getAttribute(PRINT_NOTE_UUID_ATTRIBUTE) !== options.noteUuid) {
    return { supported: false, reason: 'This note needs a complete persisted title and body before it can print.' }
  }
  return { supported: false, reason: unsupportedPrintReason }
}

function cloneCurrentBody(targetDocument: Document, source: PrintBodySource): HTMLElement {
  if (source.kind === 'super') {
    const clone = source.element.cloneNode(true) as HTMLElement
    copyLiveControlState(source.element, clone)
    copyCanvasPixels(source.element, clone)
    return sanitizePrintBody(clone, source.element)
  }

  if (source.kind === 'plain' || source.kind === 'fallback') {
    const body = targetDocument.createElement('div')
    const text = targetDocument.createElement('pre')
    text.className = 'srn-print-plain-text'
    text.textContent = source.kind === 'plain' ? source.element.value : source.text
    body.appendChild(text)
    body.id = PRINT_BODY_ID
    return body
  }

  return sanitizePrintBody(source.element.cloneNode(true) as HTMLElement)
}

/** Build, but do not attach, the exact title/body tree that will be printed. */
export function createPrintSnapshot(options: PrintNoteOptions = {}): HTMLElement | undefined {
  const source = resolvePrintSource(document, options)
  if (!source) {
    return undefined
  }

  const root = document.createElement('article')
  root.id = PRINT_ROOT_ID
  root.setAttribute('aria-hidden', 'true')

  const title = document.createElement('h1')
  title.id = PRINT_TITLE_ID
  title.textContent = source.titleText

  root.append(title, cloneCurrentBody(document, source.body))
  return root
}

/** Remove any pending print snapshot/layout and restore the normal app tree. */
export function removePrintSnapshot(): void {
  document.getElementById(PRINT_ROOT_ID)?.remove()
  document.body.classList.remove(PRINTING_BODY_CLASS)
  removePrintLayout()
}

function attachPrintSnapshot(snapshot: HTMLElement, noteUuid?: string): () => void {
  document.body.appendChild(snapshot)
  document.body.classList.add(PRINTING_BODY_CLASS)
  if (!snapshot.hasAttribute(PRINT_EMPTY_ATTRIBUTE)) {
    applyPrintLayout(noteUuid)
  }

  const state: { fallbackTimer?: number } = {}
  let cleaned = false
  const cleanup = () => {
    if (cleaned) {
      return
    }
    cleaned = true
    if (state.fallbackTimer !== undefined) {
      window.clearTimeout(state.fallbackTimer)
    }
    window.removeEventListener('afterprint', cleanup)
    removePrintSnapshot()
    if (activePrintCleanup === cleanup) {
      activePrintCleanup = undefined
    }
  }

  activePrintCleanup = cleanup
  window.addEventListener('afterprint', cleanup)
  // Some WebViews omit afterprint. Keep the inert, screen-hidden snapshot long
  // enough for asynchronous print compositors, then clean it deterministically.
  state.fallbackTimer = window.setTimeout(cleanup, PRINT_FALLBACK_CLEANUP_MS)

  return cleanup
}

function preparePrintSnapshot(options: PrintNoteOptions): (() => void) | undefined {
  activePrintCleanup?.()
  removePrintSnapshot()

  const snapshot = createPrintSnapshot(options)
  return snapshot ? attachPrintSnapshot(snapshot, options.noteUuid) : undefined
}

/** Install a deliberately blank isolated surface when native print cannot safely resolve a note. */
function prepareEmptyPrintSnapshot(): () => void {
  activePrintCleanup?.()
  removePrintSnapshot()
  const snapshot = document.createElement('article')
  snapshot.id = PRINT_ROOT_ID
  snapshot.setAttribute('aria-hidden', 'true')
  snapshot.setAttribute(PRINT_EMPTY_ATTRIBUTE, 'true')
  return attachPrintSnapshot(snapshot)
}

/**
 * Print the current unsaved title/body through an isolated snapshot. The return
 * value is an idempotent cleanup hook, useful to callers/tests that cancel early.
 */
export function printActiveNote(options: PrintNoteOptions = {}): (() => void) | undefined {
  let cleanup: (() => void) | undefined
  try {
    cleanup = preparePrintSnapshot(options)
  } catch (error) {
    console.error(error)
    return undefined
  }
  if (!cleanup) {
    return undefined
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        window.print()
      } catch (error) {
        cleanup()
        console.error(error)
      }
    })
  })

  return cleanup
}

type NativePrintOptionsProvider = () => PrintNoteOptions | null | undefined

/**
 * Route browser-menu printing and Ctrl/Cmd+P through the same isolated live
 * snapshot as the explicit Print button. Unsupported editors are never cloned;
 * their shortcut is blocked and the caller can surface the predicate's reason.
 */
export function installNativeNotePrinting(
  getOptions: NativePrintOptionsProvider = () => {
    const title = document.getElementById(ElementIds.NoteTitleEditor)
    return {
      noteUuid:
        title instanceof HTMLInputElement ? (title.getAttribute(PRINT_NOTE_UUID_ATTRIBUTE) ?? undefined) : undefined,
    }
  },
  onUnsupported?: (reason: string) => void,
): () => void {
  const notifyUnsupported = (reason: string) => {
    try {
      onUnsupported?.(reason)
    } catch {
      // Printing must remain fail-closed even if notification UI fails.
    }
  }

  const failClosedBeforePrint = (reason: string) => {
    try {
      prepareEmptyPrintSnapshot()
    } catch {
      // The stylesheet independently defaults to hiding all application roots.
      document.body.classList.add(PRINTING_BODY_CLASS)
    }
    notifyUnsupported(reason)
  }

  const handleBeforePrint = () => {
    if (document.getElementById(PRINT_ROOT_ID) && document.body.classList.contains(PRINTING_BODY_CLASS)) {
      return
    }

    try {
      const options = getOptions() ?? {}
      const support = getActiveNotePrintSupport(options)
      if (!support.supported) {
        failClosedBeforePrint(support.reason)
        return
      }

      if (!preparePrintSnapshot(options)) {
        failClosedBeforePrint(unsupportedPrintReason)
      }
    } catch {
      failClosedBeforePrint('Printing could not safely read the active note.')
    }
  }

  const handlePrintShortcut = (event: KeyboardEvent) => {
    const isPrintShortcut =
      event.key.toLowerCase() === 'p' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    if (!isPrintShortcut || !document.getElementById(ElementIds.NoteTitleEditor)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    try {
      const options = getOptions() ?? {}
      const support = getActiveNotePrintSupport(options)
      if (!support.supported) {
        notifyUnsupported(support.reason)
        return
      }

      printActiveNote(options)
    } catch {
      notifyUnsupported('Printing could not safely read the active note.')
    }
  }

  window.addEventListener('beforeprint', handleBeforePrint)
  window.addEventListener('keydown', handlePrintShortcut, true)

  return () => {
    window.removeEventListener('beforeprint', handleBeforePrint)
    window.removeEventListener('keydown', handlePrintShortcut, true)
    activePrintCleanup?.()
  }
}
