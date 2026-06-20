/**
 * Chat-tab modeling and persistence for the Assistant view.
 *
 * Tabs are persisted in localStorage (cheap, local, avoids touching the synced
 * models package, mirroring how the assistant already persists its context scope
 * and data-exposure dismissal). Message transcripts are NOT persisted here — only
 * the lightweight tab metadata (id + title + whether the user renamed it) so the
 * tab strip survives a reload.
 */

export type ChatTab = {
  id: string
  title: string
  /**
   * True once the user has manually renamed the tab. Auto-naming (from the first
   * user message) must never overwrite a user-chosen title.
   */
  userRenamed: boolean
}

export const DEFAULT_TAB_TITLE = 'New chat'

// Persisted under a plain localStorage key rather than a synced PrefKey so this
// view stays out of the models package.
export const CHAT_TABS_KEY = 'assistant-chat-tabs'

const MAX_TITLE_WORDS = 6
const MAX_TITLE_LENGTH = 40

/**
 * Derive a short, human-readable tab title from the first user message.
 *
 * Local heuristic (no API call): take the first ~6 meaningful words of the first
 * line, strip surrounding punctuation, capitalize the first letter, and append an
 * ellipsis when the message was longer than what we kept. Always works offline and
 * is deterministic, so it is the default auto-naming strategy. Returns the default
 * title for empty/whitespace-only input.
 */
export function deriveTitleFromMessage(text: string): string {
  const firstLine = (text ?? '').split('\n').find((line) => line.trim().length > 0) ?? ''
  const trimmed = firstLine.trim()
  if (!trimmed) {
    return DEFAULT_TAB_TITLE
  }

  const words = trimmed.split(/\s+/)
  const kept = words.slice(0, MAX_TITLE_WORDS)
  let title = kept.join(' ')

  // Strip leading/trailing punctuation that reads poorly as a label.
  title = title.replace(/^[\s"'`*#>\-–—:.,;!?(){}[\]]+/, '').replace(/[\s"'`*:.,;!?(){}[\]]+$/, '')

  if (!title) {
    return DEFAULT_TAB_TITLE
  }

  // Capitalize the first letter for a tidier label.
  title = title.charAt(0).toUpperCase() + title.slice(1)

  let truncatedByLength = false
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).trimEnd()
    truncatedByLength = true
  }

  const truncated = words.length > kept.length || truncatedByLength
  return truncated ? `${title}…` : title
}

const isChatTab = (value: unknown): value is ChatTab => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tab = value as Record<string, unknown>
  return (
    typeof tab.id === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.userRenamed === 'boolean'
  )
}

/**
 * Read persisted tabs from localStorage. Returns null when nothing valid is stored
 * so callers can fall back to a fresh single-tab default.
 */
export function readPersistedTabs(): ChatTab[] | null {
  try {
    const raw = localStorage.getItem(CHAT_TABS_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    const tabs = parsed.filter(isChatTab)
    return tabs.length > 0 ? tabs : null
  } catch {
    return null
  }
}

/** Persist tabs to localStorage. Best-effort; ignores storage failures. */
export function persistTabs(tabs: ChatTab[]): void {
  try {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(tabs))
  } catch {
    // Persisting tabs is best-effort; ignore storage failures (quota/private mode).
  }
}
