/**
 * Standard Red Notes: @mention tokens for note comments.
 *
 * A mention is stored INLINE in the comment text as a structured token rather
 * than a separate field, so the text stays self-describing and round-trips
 * through the E2E payload unchanged. Token syntax:
 *
 *     @[Display Name](user-uuid)
 *
 * This mirrors common markdown-mention conventions and is trivial to parse back
 * out for rendering (chip) and for the notify check (does this comment mention
 * the current user's uuid?). The stored member uuid is the source of truth; the
 * display name is only a render hint.
 */

/** A candidate shown in the @mention autocomplete. */
export type MentionCandidate = {
  /** Account uuid — the value persisted in the token. */
  userUuid: string
  /** Display name/email shown in the menu and inserted into the token. */
  name: string
}

/** A resolved mention parsed out of comment text. */
export type ParsedMention = {
  userUuid: string
  name: string
  /** Start index of the token in the source string. */
  start: number
  /** End index (exclusive) of the token in the source string. */
  end: number
}

// `@[name](uuid)` — name allows anything except a closing bracket; uuid allows
// anything except a closing paren. Non-greedy to stop at the first delimiter.
const MENTION_TOKEN = /@\[([^\]]+)\]\(([^)]+)\)/g

/** Build the inline token string for a selected mention candidate. */
export function buildMentionToken(candidate: MentionCandidate): string {
  // Defensively strip delimiter characters that would break the token grammar.
  const safeName = candidate.name.replace(/[\][()]/g, ' ').trim() || candidate.userUuid
  return `@[${safeName}](${candidate.userUuid})`
}

/** Parse every mention token out of `text`, in order of appearance. */
export function parseMentions(text: string): ParsedMention[] {
  const result: ParsedMention[] = []
  if (!text) {
    return result
  }
  MENTION_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_TOKEN.exec(text)) !== null) {
    result.push({
      name: match[1],
      userUuid: match[2],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return result
}

/** The distinct set of mentioned uuids in `text` (denormalized onto a comment). */
export function extractMentionedUuids(text: string): string[] {
  const seen = new Set<string>()
  for (const mention of parseMentions(text)) {
    seen.add(mention.userUuid)
  }
  return [...seen]
}

/** Whether `text` mentions the given user uuid. */
export function textMentionsUser(text: string, userUuid: string): boolean {
  return parseMentions(text).some((mention) => mention.userUuid === userUuid)
}

/**
 * A flat representation of comment text for rendering: an ordered list of plain
 * text runs and mention chips. Lets the UI render chips without dangerouslySet
 * HTML. Pure.
 */
export type CommentTextSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; userUuid: string; name: string }

export function segmentCommentText(text: string): CommentTextSegment[] {
  const segments: CommentTextSegment[] = []
  const mentions = parseMentions(text)
  let cursor = 0
  for (const mention of mentions) {
    if (mention.start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, mention.start) })
    }
    segments.push({ type: 'mention', userUuid: mention.userUuid, name: mention.name })
    cursor = mention.end
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }
  return segments
}

/**
 * Given the full composer value and the caret position, detect an in-progress
 * `@query` the user is typing (i.e. an `@` not yet closed into a token). Returns
 * the query text and the range to replace when a candidate is chosen, or null if
 * the caret is not inside an active mention query.
 *
 * Rules: the trigger `@` must be at the start of the string or preceded by
 * whitespace, and the query (between `@` and the caret) must not contain
 * whitespace or the `]`/`)` token delimiters.
 */
export function detectMentionQuery(
  value: string,
  caret: number,
): { query: string; replaceStart: number; replaceEnd: number } | null {
  if (caret < 0 || caret > value.length) {
    return null
  }
  // Walk backwards from the caret to find the nearest `@` that starts a query.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === '@') {
      const before = i === 0 ? '' : value[i - 1]
      if (before === '' || /\s/.test(before)) {
        const query = value.slice(i + 1, caret)
        return { query, replaceStart: i, replaceEnd: caret }
      }
      return null
    }
    // Any whitespace or token delimiter between `@` and the caret cancels it.
    if (/\s/.test(ch) || ch === ']' || ch === ')' || ch === '[' || ch === '(') {
      return null
    }
  }
  return null
}

/** Case-insensitive filter of candidates by a mention query (matches name or uuid). */
export function filterMentionCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) {
    return candidates
  }
  return candidates.filter(
    (candidate) =>
      candidate.name.toLowerCase().includes(trimmed) || candidate.userUuid.toLowerCase().includes(trimmed),
  )
}
