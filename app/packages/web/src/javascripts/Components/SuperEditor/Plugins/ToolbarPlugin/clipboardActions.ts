/**
 * Standard Red Notes: clipboard action helpers for the Super editor toolbar.
 *
 * These back the Copy / Cut / Paste split-dropdowns. The pure helpers
 * (`stripHiddenCharacters`, `htmlToPlainText`) carry no Lexical / DOM-editor
 * state and are unit-tested in `clipboardActions.spec.ts`. The async helpers
 * read `navigator.clipboard` and mutate the document inside `editor.update()`,
 * mirroring the patterns already used in `ToolbarPlugin.tsx` and
 * `GoogleDocsPastePlugin.tsx`.
 *
 * The browser clipboard surface is permission-gated and inconsistent across
 * engines (see file-level limitations below), so every async helper is
 * best-effort: it catches read/permission failures and quietly no-ops rather
 * than throwing, so it can never break the existing native copy/paste path.
 */

import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $isRootOrShadowRoot,
  $insertNodes,
  type LexicalEditor,
} from 'lexical'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $insertGeneratedNodes, $getHtmlContent } from '@lexical/clipboard'
import { $wrapNodeInElement } from '@lexical/utils'
import { INSERT_REMOTE_IMAGE_COMMAND } from '../Commands'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Matches the "hidden" characters we strip from text pasted via `pasteSafe`:
 *   - U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F  control chars
 *     (everything except TAB `\t` U+0009 and LF `\n` U+000A, which are kept)
 *   - U+00AD                soft hyphen
 *   - U+200B–U+200F         zero-width space/non-joiner/joiner, LRM/RLM marks
 *   - U+2060                word joiner
 *   - U+FEFF                zero-width no-break space / BOM
 *
 * CR (U+000D) is normalized away separately so `\r\n` collapses to `\n`.
 */
const HIDDEN_CHARACTERS_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u2060\ufeff]/g

/**
 * Removes zero-width / formatting / control characters from `text`, leaving
 * normal printable content (and TAB + newlines) intact. Carriage returns are
 * normalized so Windows-style `\r\n` becomes `\n`. Pure and side-effect free.
 */
export function stripHiddenCharacters(text: string): string {
  if (!text) {
    return ''
  }
  return text.replace(/\r\n?/g, '\n').replace(HIDDEN_CHARACTERS_REGEX, '')
}

/**
 * Converts an HTML string to plain text. Uses the DOM when available (so block
 * elements/`<br>` become newlines and tags/entities are resolved correctly),
 * and falls back to a regex-based strip in non-DOM environments. Pure with
 * respect to the editor — it touches no Lexical state.
 */
export function htmlToPlainText(html: string): string {
  if (!html) {
    return ''
  }

  if (typeof document !== 'undefined' && typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      // `<br>` and block boundaries should read as line breaks; textContent
      // alone would otherwise glue lines together.
      doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
      const BLOCK_TAGS = ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']
      doc.querySelectorAll(BLOCK_TAGS.join(',')).forEach((el) => {
        el.append('\n')
      })
      const text = doc.body.textContent ?? ''
      return normalizeWhitespace(text)
    } catch {
      /* fall through to the regex path */
    }
  }

  // Non-DOM fallback (e.g. jest without jsdom DOMParser): strip tags + decode a
  // few common entities.
  const withoutTags = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote|\/pre)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return normalizeWhitespace(decoded)
}

/** Collapses runs of blank lines and trims trailing spaces per line. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

// ---------------------------------------------------------------------------
// Clipboard read helpers (best-effort)
// ---------------------------------------------------------------------------

function getClipboard(): Clipboard | undefined {
  if (typeof navigator === 'undefined') {
    return undefined
  }
  return navigator.clipboard
}

/** Best-effort `navigator.clipboard.readText()`; returns '' on any failure. */
async function readClipboardText(): Promise<string> {
  const clipboard = getClipboard()
  if (!clipboard || typeof clipboard.readText !== 'function') {
    return ''
  }
  try {
    return (await clipboard.readText()) ?? ''
  } catch {
    return ''
  }
}

/**
 * Best-effort read of the clipboard's `text/html` item via the async
 * `clipboard.read()` API. Returns '' when unavailable / denied / absent.
 */
async function readClipboardHtml(): Promise<string> {
  const clipboard = getClipboard()
  if (!clipboard || typeof clipboard.read !== 'function') {
    return ''
  }
  try {
    const items = await clipboard.read()
    for (const item of items) {
      if (item.types.includes('text/html')) {
        const blob = await item.getType('text/html')
        return await blob.text()
      }
    }
  } catch {
    /* permission denied or unsupported */
  }
  return ''
}

/**
 * Best-effort read of the first image blob from the clipboard via
 * `clipboard.read()`. Returns `undefined` when unavailable / denied / absent.
 */
async function readClipboardImageBlob(): Promise<Blob | undefined> {
  const clipboard = getClipboard()
  if (!clipboard || typeof clipboard.read !== 'function') {
    return undefined
  }
  try {
    const items = await clipboard.read()
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (imageType) {
        return await item.getType(imageType)
      }
    }
  } catch {
    /* permission denied or unsupported */
  }
  return undefined
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image blob'))
    reader.readAsDataURL(blob)
  })
}

/** Wraps a `DataTransfer`-like object for `@lexical/clipboard` consumers. */
function makeDataTransferShim(html: string, plain: string): DataTransfer {
  const types: string[] = []
  if (html) {
    types.push('text/html')
  }
  types.push('text/plain')
  return {
    getData: (type: string) => (type === 'text/html' ? html : plain),
    types,
  } as unknown as DataTransfer
}

// ---------------------------------------------------------------------------
// Paste variants
// ---------------------------------------------------------------------------

/** Inserts `text` as plain text at the current range selection. */
function insertPlainText(text: string): void {
  const selection = $getSelection()
  if ($isRangeSelection(selection)) {
    selection.insertText(text)
  }
}

/**
 * Paste with all formatting discarded: reads the clipboard as plain text and
 * inserts it verbatim at the selection.
 */
export async function pasteWithoutFormatting(editor: LexicalEditor): Promise<void> {
  const text = await readClipboardText()
  if (!text) {
    return
  }
  editor.update(() => {
    insertPlainText(text)
  })
}

/**
 * Paste plain text with hidden / zero-width / control characters stripped
 * (`stripHiddenCharacters`). Useful for cleaning text copied from rich web
 * sources that smuggle in invisible markers.
 */
export async function pasteSafe(editor: LexicalEditor): Promise<void> {
  const raw = await readClipboardText()
  const text = stripHiddenCharacters(raw)
  if (!text) {
    return
  }
  editor.update(() => {
    insertPlainText(text)
  })
}

/**
 * Paste preserving the source HTML formatting when the clipboard carries a
 * `text/html` payload (falls back to plain text otherwise). Mirrors the
 * rich-text paste path used by `GoogleDocsPastePlugin`.
 */
export async function pasteKeepOrigin(editor: LexicalEditor): Promise<void> {
  const [html, plain] = await Promise.all([readClipboardHtml(), readClipboardText()])
  if (!html && !plain) {
    return
  }
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      return
    }
    if (html) {
      const dom = new DOMParser().parseFromString(html, 'text/html')
      const nodes = $generateNodesFromDOM(editor, dom)
      $insertGeneratedNodes(editor, nodes, selection)
    } else {
      selection.insertText(plain)
    }
  })
}

/**
 * Paste the clipboard text but keep the DESTINATION's current formatting:
 * inserts plain text at the selection (which inherits the active text format /
 * style at the caret) rather than carrying the source's styles over.
 */
export async function pasteMergeFormatting(editor: LexicalEditor): Promise<void> {
  let text = await readClipboardText()
  if (!text) {
    const html = await readClipboardHtml()
    text = htmlToPlainText(html)
  }
  if (!text) {
    return
  }
  editor.update(() => {
    // `selection.insertText` applies the selection's existing format/style to
    // the inserted text, so destination formatting is preserved.
    insertPlainText(text)
  })
}

/**
 * Paste an image from the clipboard. Reads an image blob via
 * `clipboard.read()`, converts it to a data-URL, and inserts it. When the
 * editor has registered the remote-image command (the existing image node),
 * that node is reused; otherwise the data-URL image is inserted directly.
 */
export async function pasteAsImage(editor: LexicalEditor): Promise<void> {
  const blob = await readClipboardImageBlob()
  if (!blob) {
    return
  }
  let dataUrl = ''
  try {
    dataUrl = await blobToDataURL(blob)
  } catch {
    return
  }
  if (!dataUrl) {
    return
  }
  insertImageDataUrl(editor, dataUrl)
}

/**
 * Inserts an image by data-URL, reusing the editor's existing image node when
 * the `INSERT_REMOTE_IMAGE_COMMAND` handler is registered; otherwise wraps a
 * raw `<img>` element via the rich-text clipboard path.
 */
function insertImageDataUrl(editor: LexicalEditor, dataUrl: string): void {
  // Preferred path: dispatch the existing image command so we reuse whatever
  // image/inline-file node the editor already understands. `dispatchCommand`
  // returns true when a handler consumed it.
  const handled = editor.dispatchCommand(INSERT_REMOTE_IMAGE_COMMAND, dataUrl)
  if (handled) {
    return
  }

  // Fallback: synthesize an <img> and let Lexical's HTML import build whatever
  // image node is registered for it, inserting at the current selection (or
  // appending to the root if there is none).
  editor.update(() => {
    const html = `<img src="${escapeAttribute(dataUrl)}" alt="" />`
    const dom = new DOMParser().parseFromString(html, 'text/html')
    const nodes = $generateNodesFromDOM(editor, dom)
    if (nodes.length === 0) {
      return
    }
    const selection = $getSelection()
    if ($isRangeSelection(selection)) {
      $insertGeneratedNodes(editor, nodes, selection)
      return
    }
    $insertNodes(nodes)
    const first = nodes[0]
    if (first && $isRootOrShadowRoot(first.getParentOrThrow())) {
      $wrapNodeInElement(first, $createParagraphNode).selectEnd()
    }
  })
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Copy / Cut variants
// ---------------------------------------------------------------------------

function getClipboardWriteText(): ((text: string) => Promise<void>) | undefined {
  const clipboard = getClipboard()
  if (clipboard && typeof clipboard.writeText === 'function') {
    return clipboard.writeText.bind(clipboard)
  }
  return undefined
}

/** Best-effort plain-text clipboard write; no-ops when unavailable. */
async function writeClipboardText(text: string): Promise<boolean> {
  const writeText = getClipboardWriteText()
  if (!writeText) {
    return false
  }
  try {
    await writeText(text)
    return true
  } catch {
    return false
  }
}

/** Reads the selected nodes' plain-text content from the current editor state. */
function readSelectionText(editor: LexicalEditor): string {
  let text = ''
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      text = selection.getTextContent()
    }
  })
  return text
}

/** Reads the selected nodes' HTML content from the current editor state. */
function readSelectionHtml(editor: LexicalEditor): string {
  let html = ''
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (selection && !selection.isCollapsed?.()) {
      html = $getHtmlContent(editor)
    }
  })
  return html
}

/** Deletes the current non-collapsed selection. */
function deleteSelection(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      selection.insertText('')
    }
  })
}

/**
 * Copy the selection as plain text only (formatting/HTML discarded). This is
 * the same plain-text result the native toolbar Copy already produces, exposed
 * here as a named variant for the split-dropdown.
 */
export async function copyWithoutFormatting(editor: LexicalEditor): Promise<void> {
  const text = readSelectionText(editor)
  if (text) {
    await writeClipboardText(text)
  }
}

/** Alias-style variant: copy the selection's text content only. */
export async function copyTextOnly(editor: LexicalEditor): Promise<void> {
  await copyWithoutFormatting(editor)
}

/**
 * Copy only the image references contained in the selection (their textual
 * representation, e.g. markdown image syntax / src). No-ops when the selection
 * holds no images.
 */
export async function copyImagesOnly(editor: LexicalEditor): Promise<void> {
  const text = collectSelectionImageText(editor)
  if (text) {
    await writeClipboardText(text)
  }
}

/**
 * Gathers a newline-joined textual representation of every image-like node in
 * the current selection. "Image-like" is detected structurally (node type
 * contains "image" or "file") so this works regardless of which concrete image
 * node the editor registered, without importing those node classes.
 */
function collectSelectionImageText(editor: LexicalEditor): string {
  const parts: string[] = []
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!selection) {
      return
    }
    const nodes = selection.getNodes()
    for (const node of nodes) {
      const type = node.getType().toLowerCase()
      if (type.includes('image') || type.includes('file')) {
        const content = node.getTextContent()
        if (content) {
          parts.push(content)
        }
      }
    }
  })
  return parts.join('\n')
}

/** Cut the selection as plain text (copy text only, then delete selection). */
export async function cutWithoutFormatting(editor: LexicalEditor): Promise<void> {
  const text = readSelectionText(editor)
  if (!text) {
    return
  }
  const wrote = await writeClipboardText(text)
  if (wrote) {
    deleteSelection(editor)
  }
}

/** Cut the selection's text content only. */
export async function cutTextOnly(editor: LexicalEditor): Promise<void> {
  await cutWithoutFormatting(editor)
}

/**
 * Cut only the image-like nodes in the selection: copies their text
 * representation to the clipboard, then removes those nodes from the document.
 */
export async function cutImagesOnly(editor: LexicalEditor): Promise<void> {
  const text = collectSelectionImageText(editor)
  if (!text) {
    return
  }
  const wrote = await writeClipboardText(text)
  if (!wrote) {
    return
  }
  editor.update(() => {
    const selection = $getSelection()
    if (!selection) {
      return
    }
    for (const node of selection.getNodes()) {
      const type = node.getType().toLowerCase()
      if (type.includes('image') || type.includes('file')) {
        node.remove()
      }
    }
  })
}

// Referenced to keep the rich-HTML copy path available to integrators wiring a
// "copy with formatting" entry without re-importing @lexical/html here.
export { readSelectionHtml as $readSelectionHtmlForCopy }
// `$generateHtmlFromNodes` is intentionally re-exported for integrators that
// want a full-document HTML copy variant in the dropdown.
export { $generateHtmlFromNodes as $generateHtmlForCopy }
