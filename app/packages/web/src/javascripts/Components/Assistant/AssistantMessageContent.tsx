import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { sanitizeHtmlString } from '@standardnotes/utils'
import { markdownToHtml } from '@/Utils/markdownToHtml'
import { splitAssistantSources } from '@/Assistant/assistantSources'

export const ASSISTANT_STREAM_MARKDOWN_INTERVAL_MS = 200

/** Reuse note-preview Markdown, with no automatic remote resource loads. */
export function assistantMarkdownHtml(text: string): string {
  const template = document.createElement('template')
  template.innerHTML = sanitizeHtmlString(markdownToHtml(text))
  for (const element of template.content.querySelectorAll('[style]')) {
    element.removeAttribute('style')
  }
  for (const image of template.content.querySelectorAll('img')) {
    image.replaceWith(document.createTextNode(image.alt ? `[Image: ${image.alt}]` : '[Image]'))
  }
  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    const fragment = href.startsWith('#')
    let allowed = fragment
    try {
      allowed ||= ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)
    } catch {
      // Relative/file/custom-scheme destinations are inert in generated text.
    }
    if (!allowed) {
      link.removeAttribute('href')
      link.removeAttribute('target')
    } else if (fragment) {
      link.removeAttribute('target')
    } else {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    }
  }
  return template.innerHTML
}

export default function AssistantMessageContent({
  text,
  streaming,
  messageTextRef,
}: {
  text: string
  streaming?: boolean
  messageTextRef: RefObject<HTMLDivElement | null>
}) {
  const [format, setFormat] = useState<'markdown' | 'plain'>('markdown')
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [formattedText, setFormattedText] = useState(text)
  const latestText = useRef(text)
  latestText.current = text
  const formatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!streaming || format === 'plain') {
      if (formatTimer.current !== undefined) {
        clearTimeout(formatTimer.current)
        formatTimer.current = undefined
      }
      return
    }
    if (formattedText !== text && formatTimer.current === undefined) {
      formatTimer.current = setTimeout(() => {
        formatTimer.current = undefined
        setFormattedText(latestText.current)
      }, ASSISTANT_STREAM_MARKDOWN_INTERVAL_MS)
    }
  }, [format, formattedText, streaming, text])
  useEffect(
    () => () => {
      if (formatTimer.current !== undefined) {
        clearTimeout(formatTimer.current)
      }
    },
    [],
  )
  // Append-only deltas stay visible as plain text until the next bounded Markdown
  // update. A replaced response never exposes an old account/message's snapshot.
  const markdownText = !streaming ? text : text.startsWith(formattedText) ? formattedText : ''
  const pendingText = streaming ? text.slice(markdownText.length) : ''
  const sections = useMemo(
    () => (streaming ? { body: markdownText, sources: '', count: 0 } : splitAssistantSources(markdownText)),
    [markdownText, streaming],
  )
  const html = useMemo(
    () => (format === 'markdown' ? assistantMarkdownHtml(sections.body) : ''),
    [sections.body, format],
  )
  const sourcesHtml = useMemo(
    () => (format === 'markdown' && sourcesExpanded && sections.sources ? assistantMarkdownHtml(sections.sources) : ''),
    [format, sourcesExpanded, sections.sources],
  )
  return (
    <div className="text-text min-w-0 py-1 text-sm leading-5">
      <div
        role="group"
        aria-label="Message display format"
        className="mb-1 flex justify-end gap-0.5 text-[10px] leading-4"
      >
        {(['markdown', 'plain'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={format === value}
            className={
              format === value
                ? 'bg-default rounded px-1.5 font-medium'
                : 'text-passive-1 hover:bg-default rounded px-1.5'
            }
            onClick={() => setFormat(value)}
          >
            {value === 'markdown' ? 'Markdown' : 'Plain text'}
          </button>
        ))}
      </div>
      <div ref={messageTextRef}>
        {format === 'plain' ? (
          <div className="break-words whitespace-pre-wrap">{text}</div>
        ) : (
          <div>
            <div
              className="[&_th]:border-border [&_th]:bg-default [&_td]:border-border [&_a]:text-info [&_blockquote]:border-info [&_code]:bg-default [&_pre]:bg-default overflow-x-auto break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_h1]:my-2 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:my-2 [&_h2]:text-base [&_h2]:font-bold [&_h3]:my-1 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre_code]:p-0 [&_pre_code]:whitespace-pre [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {pendingText && <span className="break-words whitespace-pre-wrap">{pendingText}</span>}
            {sections.sources && (
              <details
                className="border-border mt-2 rounded border px-2 py-1 text-xs"
                onToggle={(event) => setSourcesExpanded(event.currentTarget.open)}
              >
                <summary className="text-passive-1 cursor-pointer">Sources · {sections.count}</summary>
                {sourcesExpanded && (
                  <div
                    className="[&_a]:text-info max-h-80 overflow-auto break-words [&_a]:underline [&_h2]:mt-2 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:my-1 [&_ul]:pl-3"
                    dangerouslySetInnerHTML={{ __html: sourcesHtml }}
                  />
                )}
              </details>
            )}
          </div>
        )}
      </div>
      {streaming && (
        <div role="status" aria-label="Generating response" className="text-passive-1 mt-1 text-xs leading-4">
          Working…
        </div>
      )}
    </div>
  )
}
