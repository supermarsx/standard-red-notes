import { FunctionComponent, KeyboardEvent, useCallback, useMemo, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import {
  buildMentionToken,
  detectMentionQuery,
  filterMentionCandidates,
  MentionCandidate,
} from '@/Comments/mentions'

type Props = {
  candidates: MentionCandidate[]
  placeholder?: string
  autoFocus?: boolean
  submitLabel?: string
  onSubmit: (text: string) => void
  onCancel?: () => void
}

/**
 * A comment composer textarea with inline @mention autocomplete.
 *
 * Typing `@` after whitespace (or at the start) opens a menu of the note's
 * shared-vault members; choosing one inserts a `@[Name](uuid)` token (see
 * mentions.ts), so the persisted/relayed text carries the member uuid. The menu
 * is keyboard-navigable (arrow keys, Enter to choose, Escape to close). Enter
 * (without Shift) submits the comment; Shift+Enter inserts a newline.
 */
export const CommentComposer: FunctionComponent<Props> = ({
  candidates,
  placeholder,
  autoFocus,
  submitLabel = 'Comment',
  onSubmit,
  onCancel,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')
  const [query, setQuery] = useState<{ query: string; replaceStart: number; replaceEnd: number } | null>(null)
  const [highlighted, setHighlighted] = useState(0)

  const filtered = useMemo(() => {
    if (!query) {
      return []
    }
    return filterMentionCandidates(candidates, query.query).slice(0, 8)
  }, [candidates, query])

  const menuOpen = query !== null && filtered.length > 0

  const recomputeQuery = useCallback(
    (nextValue: string, caret: number) => {
      if (candidates.length === 0) {
        setQuery(null)
        return
      }
      const detected = detectMentionQuery(nextValue, caret)
      setQuery(detected)
      setHighlighted(0)
    },
    [candidates.length],
  )

  const handleChange = useCallback(
    (event: { target: HTMLTextAreaElement }) => {
      const nextValue = event.target.value
      setValue(nextValue)
      recomputeQuery(nextValue, event.target.selectionStart ?? nextValue.length)
    },
    [recomputeQuery],
  )

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      if (!query) {
        return
      }
      const token = buildMentionToken(candidate)
      const before = value.slice(0, query.replaceStart)
      const after = value.slice(query.replaceEnd)
      // Add a trailing space so the user keeps typing after the chip.
      const nextValue = `${before}${token} ${after}`
      setValue(nextValue)
      setQuery(null)
      // Restore focus + place caret right after the inserted token.
      const caret = before.length + token.length + 1
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(caret, caret)
        }
      })
    },
    [query, value],
  )

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) {
      return
    }
    onSubmit(trimmed)
    setValue('')
    setQuery(null)
  }, [value, onSubmit])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHighlighted((h) => (h + 1) % filtered.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlighted((h) => (h - 1 + filtered.length) % filtered.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          insertMention(filtered[highlighted])
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setQuery(null)
          return
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
        return
      }
      if (event.key === 'Escape' && onCancel) {
        event.preventDefault()
        onCancel()
      }
    },
    [menuOpen, filtered, highlighted, insertMention, submit, onCancel],
  )

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(event) => recomputeQuery(value, event.currentTarget.selectionStart ?? 0)}
        placeholder={placeholder ?? 'Add a comment… use @ to mention someone'}
        rows={2}
        className="w-full resize-y rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:border-info focus:outline-none"
      />
      {menuOpen && (
        <ul
          className="absolute left-0 right-0 z-10 mt-1 max-h-44 overflow-y-auto rounded border border-border bg-default py-1 shadow-main"
          role="listbox"
        >
          {filtered.map((candidate, index) => (
            <li key={candidate.userUuid} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                onMouseDown={(event) => {
                  // mousedown (not click) so the textarea doesn't blur first.
                  event.preventDefault()
                  insertMention(candidate)
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
                  index === highlighted ? 'bg-info-backdrop text-info' : 'text-text'
                }`}
              >
                <Icon type="user" className="text-passive-1" size="small" />
                <span className="truncate">{candidate.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs text-passive-1 hover:bg-contrast"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={value.trim().length === 0}
          className="rounded bg-info px-3 py-1 text-xs font-semibold text-info-contrast disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

export default CommentComposer
