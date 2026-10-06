import { lazy, Suspense } from 'react'
import { sanitizeHtmlString } from '@standardnotes/snjs'
import { markdownToHtml } from '@/Utils/markdownToHtml'
import { resolveSharedNoteFormat, type SharedNoteFormat } from './SharedNoteFormat'

/**
 * The body of one shared note, rendered by the renderer its own format needs.
 *
 * BEFORE this existed, every shared note — Super, plaintext, legacy rich text,
 * code — went through `markdownToHtml`. Measured in headless Chrome against a
 * share link for each kind:
 *
 *   super         7 320 characters of raw Lexical JSON on screen, 0 lists,
 *                 0 tables, 0 diagrams
 *   rich-text     the markup printed as text: `<h1>Title</h1><p>…` visible
 *   code          markdown-reflowed: indentation and line breaks collapsed
 *   plain-text    markdown-interpreted: a literal `*` became emphasis and a
 *                 leading `#` became a heading
 *   markdown      correct (this is the renderer it was written for)
 *
 * The Super renderer is loaded lazily. It pulls in Lexical and the whole node
 * registry (mermaid, excalidraw, katex, prism, the chart nodes), which is
 * megabytes a reader of a plaintext note must not pay for, and which webpack
 * would otherwise fold into the single `app.js` the public page loads first.
 */
const SharedSuperContent = lazy(() => import('./SharedSuperContent'))

const markdownHtml = (text: string): string => sanitizeHtmlString(markdownToHtml(text ?? ''))

/**
 * Legacy rich-text notes. `sanitizeHtmlString` is the same sanitizer that
 * already guards every `dangerouslySetInnerHTML` sink in the app, including
 * this viewer (see `utils/.../sanitizeHtmlString.spec.ts`, whose XSS battery
 * names the public SharedView explicitly). It is applied here because this is a
 * NEW sink: the markdown path escapes `<` before the sanitizer ever sees it, so
 * until now no attacker-authored markup reached the DOM on this page at all.
 */
const legacyHtml = (text: string): string => sanitizeHtmlString(text ?? '')

const SharedNoteBody = ({
  format,
  text,
  onBlockedMutation,
}: {
  format: SharedNoteFormat
  text: string
  onBlockedMutation?: (count: number) => void
}) => {
  switch (format) {
    case 'super':
      return (
        <Suspense fallback={<div className="text-passive-0 py-4">…</div>}>
          <SharedSuperContent text={text} onBlockedMutation={onBlockedMutation} />
        </Suspense>
      )
    case 'html':
      return (
        <div
          data-shared-note-format="html"
          className="markdown-preview font-editor break-words"
          dangerouslySetInnerHTML={{ __html: legacyHtml(text) }}
        />
      )
    case 'plain':
    case 'code':
      // Verbatim, with whitespace preserved. A plaintext or code note has no
      // markup to interpret, and interpreting it anyway is how a literal `*`
      // in a plaintext note turned into emphasis and a code block lost its
      // indentation.
      return (
        <pre
          data-shared-note-format={format}
          className="font-editor m-0 overflow-x-auto break-words whitespace-pre-wrap"
        >
          {text}
        </pre>
      )
    default:
      return (
        <div
          data-shared-note-format="markdown"
          className="markdown-preview font-editor break-words"
          dangerouslySetInnerHTML={{ __html: markdownHtml(text) }}
        />
      )
  }
}

export const SharedNoteContent = ({
  text,
  noteType,
  onBlockedMutation,
}: {
  text: string
  noteType?: unknown
  onBlockedMutation?: (count: number) => void
}) => {
  const format = resolveSharedNoteFormat(noteType, text)
  return <SharedNoteBody format={format} text={text} onBlockedMutation={onBlockedMutation} />
}

export default SharedNoteContent
