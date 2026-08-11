import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { applyPrintLayout, PRINT_BODY_ID, removePrintLayout } from '@/Components/SuperEditor/Layout/applyPrintLayout'

export const PRINT_ROOT_ID = 'srn-print-root'
export const PRINT_TITLE_ID = 'srn-print-title'
export const PRINTING_BODY_CLASS = 'srn-printing'

const PRINT_FALLBACK_CLEANUP_MS = 60_000
let activePrintCleanup: (() => void) | undefined

type PrintNoteOptions = {
  noteUuid?: string
  fallbackTitle?: string
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
export function sanitizePrintBody(body: HTMLElement): HTMLElement {
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

function cloneCurrentBody(targetDocument: Document): HTMLElement {
  const superEditor = targetDocument.getElementById(SuperEditorContentId)
  if (superEditor instanceof HTMLElement) {
    const clone = superEditor.cloneNode(true) as HTMLElement
    copyLiveControlState(superEditor, clone)
    copyCanvasPixels(superEditor, clone)
    return sanitizePrintBody(clone)
  }

  const plainEditor = targetDocument.getElementById(ElementIds.NoteTextEditor)
  if (plainEditor instanceof HTMLTextAreaElement || plainEditor instanceof HTMLInputElement) {
    const body = targetDocument.createElement('div')
    const text = targetDocument.createElement('pre')
    text.className = 'srn-print-plain-text'
    text.textContent = plainEditor.value
    body.appendChild(text)
    body.id = PRINT_BODY_ID
    return body
  }

  const markdownPreview = targetDocument.querySelector<HTMLElement>(`#${ElementIds.EditorContent} .markdown-preview`)
  if (markdownPreview) {
    return sanitizePrintBody(markdownPreview.cloneNode(true) as HTMLElement)
  }

  // Unsupported/custom editors still get a valid title-only print rather than
  // a clone of #editor-content (which may contain arbitrary component chrome).
  const body = targetDocument.createElement('div')
  body.id = PRINT_BODY_ID
  return body
}

/** Build, but do not attach, the exact title/body tree that will be printed. */
export function createPrintSnapshot(options: Pick<PrintNoteOptions, 'fallbackTitle'> = {}): HTMLElement {
  const titleInput = document.getElementById(ElementIds.NoteTitleEditor)
  const currentTitle = titleInput instanceof HTMLInputElement ? titleInput.value : (options.fallbackTitle ?? '')

  const root = document.createElement('article')
  root.id = PRINT_ROOT_ID
  root.setAttribute('aria-hidden', 'true')

  const title = document.createElement('h1')
  title.id = PRINT_TITLE_ID
  title.textContent = currentTitle

  root.append(title, cloneCurrentBody(document))
  return root
}

/** Remove any pending print snapshot/layout and restore the normal app tree. */
export function removePrintSnapshot(): void {
  document.getElementById(PRINT_ROOT_ID)?.remove()
  document.body.classList.remove(PRINTING_BODY_CLASS)
  removePrintLayout()
}

/**
 * Print the current unsaved title/body through an isolated snapshot. The return
 * value is an idempotent cleanup hook, useful to callers/tests that cancel early.
 */
export function printActiveNote(options: PrintNoteOptions = {}): () => void {
  activePrintCleanup?.()
  removePrintSnapshot()

  const snapshot = createPrintSnapshot(options)
  document.body.appendChild(snapshot)
  document.body.classList.add(PRINTING_BODY_CLASS)
  applyPrintLayout(options.noteUuid)

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
