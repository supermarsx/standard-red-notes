// Standard Red Notes: elaborate note-search query syntax.
//
// Parses a raw search-bar string into a structured query of free text plus a set
// of operators (filters), and produces a pure predicate that decides whether a
// given note matches. This runs entirely client-side over already-decrypted
// notes, so end-to-end encryption is preserved.
//
// Supported grammar (operators may appear anywhere, interleaved with free text):
//
//   tag:work            note is linked to a topic (tag) whose title matches "work"
//   topic:work          alias of tag: (topics and tags are the same concept)
//   type:super          note's editor type (NoteType) is "super"
//   editor:code         alias of type:
//   in:title            restrict the free-text match to the note title
//   in:content          restrict the free-text match to the note body
//   created:>2024-01-01 created after a date (also <, >=, <=, =)
//   updated:<2025-01-01 last modified before a date
//   is:protected        flag filters: protected | pinned | archived |
//                       starred | trashed | locked | template-ish aliases
//   "quoted phrase"     a phrase that must appear verbatim in the free text
//   -tag:foo            negation: any operator (or word/phrase) may be negated
//
// Anything that is not a recognized operator falls back to the existing
// full-text match (free text). Unknown operators (e.g. `foo:bar`) are forgiving:
// they are treated as plain free text rather than rejected.
//
// The module is intentionally dependency-free and synchronous so it can be unit
// tested and reused by both the live content list and tests.

export type DateComparator = '>' | '<' | '>=' | '<=' | '='

export type NoteFlag = 'protected' | 'pinned' | 'archived' | 'starred' | 'trashed' | 'locked'

export type SearchScope = 'title' | 'content'

/** A single parsed operator term. `negated` flips the match. */
export type SearchOperator =
  | { kind: 'tag'; value: string; negated: boolean }
  | { kind: 'type'; value: string; negated: boolean }
  | { kind: 'is'; flag: NoteFlag; negated: boolean }
  | { kind: 'in'; scope: SearchScope; negated: boolean }
  | { kind: 'created'; comparator: DateComparator; date: number; negated: boolean }
  | { kind: 'updated'; comparator: DateComparator; date: number; negated: boolean }

/** A single free-text phrase (a bare word or a quoted phrase). */
export type FreeTextTerm = { value: string; negated: boolean }

export interface ParsedSearchQuery {
  /** Recognized operator filters. */
  operators: SearchOperator[]
  /** Free-text phrases that fall through to the existing full-text match. */
  freeTextTerms: FreeTextTerm[]
  /**
   * The free text re-joined as a single string, suitable for handing to the
   * existing substring / relevance / index search. Negated free-text terms are
   * excluded here (they are enforced by the predicate instead).
   */
  freeText: string
  /** True when at least one operator was parsed (i.e. it's an "advanced" query). */
  hasOperators: boolean
}

/** The minimal, decrypted note shape the predicate evaluates against. */
export interface SearchableNote {
  title: string
  /** Readable plaintext body (Super notes must be pre-extracted). */
  text: string
  /** Editor type, e.g. "super", "code", "markdown", "plain-text". */
  noteType?: string
  /** Titles of every tag linked to the note (lowercased compare is done here). */
  tagTitles: string[]
  protected: boolean
  pinned: boolean
  archived: boolean
  starred: boolean
  trashed: boolean
  locked: boolean
  /** created_at as epoch ms. */
  createdAt: number
  /** updated_at (user-modified) as epoch ms. */
  updatedAt: number
}

const FLAG_KEYWORDS: Record<string, NoteFlag> = {
  protected: 'protected',
  pinned: 'pinned',
  archived: 'archived',
  starred: 'starred',
  star: 'starred',
  favorite: 'starred',
  favorited: 'starred',
  trashed: 'trashed',
  trash: 'trashed',
  deleted: 'trashed',
  locked: 'locked',
}

/** Tokenize honoring double-quoted phrases. Returns raw tokens (quotes stripped). */
function tokenize(input: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = []
  const regex = /-?"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input)) !== null) {
    if (match[1] !== undefined) {
      // Quoted phrase; preserve a leading '-' that sits just before the quote.
      const negated = match[0].startsWith('-')
      tokens.push({ value: (negated ? '-' : '') + match[1], quoted: true })
    } else {
      tokens.push({ value: match[2], quoted: false })
    }
  }
  return tokens
}

/** Parse a `created:`/`updated:` value like `>2024-01-01` into comparator + epoch ms. */
function parseDateOperand(raw: string): { comparator: DateComparator; date: number } | null {
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(raw)
  if (!match) {
    return null
  }
  const comparator = (match[1] as DateComparator) || '='
  const dateString = match[2].trim()
  if (dateString.length === 0) {
    return null
  }
  // Accept YYYY-MM-DD and anything Date can parse. Bare YYYY-MM-DD is treated as
  // local midnight so day comparisons are intuitive.
  const ms = Date.parse(dateString)
  if (Number.isNaN(ms)) {
    return null
  }
  return { comparator, date: ms }
}

/**
 * Parse a raw search string into a structured query. Always succeeds; anything
 * unrecognized degrades to free text so the box never "breaks".
 */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const operators: SearchOperator[] = []
  const freeTextTerms: FreeTextTerm[] = []

  for (const token of tokenize(input ?? '')) {
    let value = token.value
    let negated = false
    if (value.startsWith('-') && value.length > 1) {
      negated = true
      value = value.slice(1)
    }

    // A quoted token is always free text (its phrase may contain a colon).
    if (token.quoted) {
      if (value.length > 0) {
        freeTextTerms.push({ value, negated })
      }
      continue
    }

    const colonIndex = value.indexOf(':')
    if (colonIndex <= 0 || colonIndex === value.length - 1) {
      // No operator form; treat as free text.
      if (value.length > 0) {
        freeTextTerms.push({ value, negated })
      }
      continue
    }

    const key = value.slice(0, colonIndex).toLowerCase()
    const operand = value.slice(colonIndex + 1)

    const operator = buildOperator(key, operand, negated)
    if (operator) {
      operators.push(operator)
    } else {
      // Unknown operator → forgiving fallback to free text (keep it verbatim).
      freeTextTerms.push({ value, negated })
    }
  }

  const freeText = freeTextTerms
    .filter((term) => !term.negated)
    .map((term) => term.value)
    .join(' ')

  return {
    operators,
    freeTextTerms,
    freeText,
    hasOperators: operators.length > 0,
  }
}

function buildOperator(key: string, operand: string, negated: boolean): SearchOperator | null {
  switch (key) {
    case 'tag':
    case 'topic': {
      // `topic:` is a user-facing alias of `tag:`; both produce a 'tag' operator
      // so the underlying behavior is identical and `tag:` keeps working.
      const value = operand.trim()
      return value.length > 0 ? { kind: 'tag', value, negated } : null
    }
    case 'type':
    case 'editor': {
      const value = operand.trim().toLowerCase()
      return value.length > 0 ? { kind: 'type', value, negated } : null
    }
    case 'is': {
      const flag = FLAG_KEYWORDS[operand.trim().toLowerCase()]
      return flag ? { kind: 'is', flag, negated } : null
    }
    case 'in': {
      const scope = operand.trim().toLowerCase()
      if (scope === 'title') {
        return { kind: 'in', scope: 'title', negated }
      }
      if (scope === 'content' || scope === 'body' || scope === 'text') {
        return { kind: 'in', scope: 'content', negated }
      }
      return null
    }
    case 'created':
    case 'updated':
    case 'modified': {
      const parsed = parseDateOperand(operand)
      if (!parsed) {
        return null
      }
      const kind = key === 'created' ? 'created' : 'updated'
      return { kind, comparator: parsed.comparator, date: parsed.date, negated }
    }
    default:
      return null
  }
}

/**
 * The structured form the advanced-search options panel edits. It is derived
 * from (and re-serialized into) the same query string the text box uses, so the
 * panel and the power-user operators stay in lock-step.
 */
export interface AdvancedSearchOptions {
  freeText: string
  tags: string[]
  notTags: string[]
  type: string
  scope: SearchScope | 'all'
  flags: Record<NoteFlag, boolean>
  createdAfter: string
  createdBefore: string
  updatedAfter: string
  updatedBefore: string
}

export const emptyAdvancedSearchOptions = (): AdvancedSearchOptions => ({
  freeText: '',
  tags: [],
  notTags: [],
  type: '',
  scope: 'all',
  flags: { protected: false, pinned: false, archived: false, starred: false, trashed: false, locked: false },
  createdAfter: '',
  createdBefore: '',
  updatedAfter: '',
  updatedBefore: '',
})

/** A tag value that contains whitespace must be quoted to round-trip. */
function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

/** Read a query string into the panel's structured options. */
export function parseAdvancedSearchOptions(input: string): AdvancedSearchOptions {
  const parsed = parseSearchQuery(input)
  const options = emptyAdvancedSearchOptions()

  options.freeText = parsed.freeTextTerms
    .map((term) => (term.negated ? '-' : '') + (/\s/.test(term.value) ? `"${term.value}"` : term.value))
    .join(' ')

  for (const op of parsed.operators) {
    switch (op.kind) {
      case 'tag':
        ;(op.negated ? options.notTags : options.tags).push(op.value)
        break
      case 'type':
        options.type = op.value
        break
      case 'in':
        options.scope = op.negated ? (op.scope === 'title' ? 'content' : 'title') : op.scope
        break
      case 'is':
        if (!op.negated) {
          options.flags[op.flag] = true
        }
        break
      case 'created':
      case 'updated': {
        const iso = new Date(op.date).toISOString().slice(0, 10)
        const target =
          op.kind === 'created'
            ? op.comparator === '<' || op.comparator === '<='
              ? 'createdBefore'
              : 'createdAfter'
            : op.comparator === '<' || op.comparator === '<='
              ? 'updatedBefore'
              : 'updatedAfter'
        options[target] = iso
        break
      }
    }
  }

  return options
}

/** Serialize the panel's structured options back into a query string. */
export function buildQueryFromOptions(options: AdvancedSearchOptions): string {
  const parts: string[] = []

  for (const tag of options.tags) {
    if (tag.trim().length > 0) {
      parts.push(`tag:${quoteIfNeeded(tag.trim())}`)
    }
  }
  for (const tag of options.notTags) {
    if (tag.trim().length > 0) {
      parts.push(`-tag:${quoteIfNeeded(tag.trim())}`)
    }
  }
  if (options.type.trim().length > 0) {
    parts.push(`type:${options.type.trim()}`)
  }
  if (options.scope === 'title') {
    parts.push('in:title')
  } else if (options.scope === 'content') {
    parts.push('in:content')
  }
  for (const flag of Object.keys(options.flags) as NoteFlag[]) {
    if (options.flags[flag]) {
      parts.push(`is:${flag}`)
    }
  }
  if (options.createdAfter.trim().length > 0) {
    parts.push(`created:>${options.createdAfter.trim()}`)
  }
  if (options.createdBefore.trim().length > 0) {
    parts.push(`created:<${options.createdBefore.trim()}`)
  }
  if (options.updatedAfter.trim().length > 0) {
    parts.push(`updated:>${options.updatedAfter.trim()}`)
  }
  if (options.updatedBefore.trim().length > 0) {
    parts.push(`updated:<${options.updatedBefore.trim()}`)
  }

  const freeText = options.freeText.trim()
  if (freeText.length > 0) {
    parts.push(freeText)
  }

  return parts.join(' ')
}

function compareDate(value: number, comparator: DateComparator, target: number): boolean {
  switch (comparator) {
    case '>':
      return value > target
    case '<':
      return value < target
    case '>=':
      return value >= target
    case '<=':
      return value <= target
    case '=': {
      // Equality on a date means "same calendar day" so `created:=2024-01-01`
      // is useful even though notes carry a precise timestamp.
      const startOfDay = new Date(target)
      startOfDay.setHours(0, 0, 0, 0)
      const endOfDay = new Date(target)
      endOfDay.setHours(23, 59, 59, 999)
      return value >= startOfDay.getTime() && value <= endOfDay.getTime()
    }
    default:
      return false
  }
}

function noteFlag(note: SearchableNote, flag: NoteFlag): boolean {
  return note[flag]
}

/** Does the free text (respecting any `in:` scope) appear in the note? */
function freeTextMatches(
  note: SearchableNote,
  terms: FreeTextTerm[],
  scope: SearchScope | undefined,
  caseSensitive: boolean,
): boolean {
  if (terms.length === 0) {
    return true
  }

  const normalize = (s: string) => (caseSensitive ? s : s.toLowerCase())
  const haystacks: string[] = []
  if (scope === 'title') {
    haystacks.push(normalize(note.title))
  } else if (scope === 'content') {
    haystacks.push(normalize(note.text))
  } else {
    haystacks.push(normalize(note.title), normalize(note.text))
  }

  return terms.every((term) => {
    const needle = normalize(term.value)
    const present = haystacks.some((hay) => hay.includes(needle))
    return term.negated ? !present : present
  })
}

export interface PredicateOptions {
  /** When true, free-text matching is case sensitive. Default false. */
  caseSensitive?: boolean
}

/**
 * Build a pure predicate from a parsed query. The predicate returns true when a
 * note satisfies every operator AND the free-text constraints. An empty query
 * (no operators, no free text) matches everything.
 */
export function buildSearchPredicate(
  parsed: ParsedSearchQuery,
  options: PredicateOptions = {},
): (note: SearchableNote) => boolean {
  const caseSensitive = options.caseSensitive ?? false

  // An `in:` operator narrows where the free text is searched.
  const scopeOperator = parsed.operators.find((op): op is Extract<SearchOperator, { kind: 'in' }> => op.kind === 'in')
  // A negated `in:title` is read as "search content instead", and vice versa.
  let scope: SearchScope | undefined
  if (scopeOperator) {
    if (!scopeOperator.negated) {
      scope = scopeOperator.scope
    } else {
      scope = scopeOperator.scope === 'title' ? 'content' : 'title'
    }
  }

  return (note: SearchableNote): boolean => {
    for (const op of parsed.operators) {
      switch (op.kind) {
        case 'in':
          // Handled via `scope` for free-text; nothing to assert on its own.
          break
        case 'tag': {
          const needle = op.value.toLowerCase()
          const present = note.tagTitles.some((title) => title.toLowerCase().includes(needle))
          if (present === op.negated) {
            return false
          }
          break
        }
        case 'type': {
          const present = (note.noteType ?? 'plain-text').toLowerCase().includes(op.value)
          if (present === op.negated) {
            return false
          }
          break
        }
        case 'is': {
          const present = noteFlag(note, op.flag)
          if (present === op.negated) {
            return false
          }
          break
        }
        case 'created': {
          const present = compareDate(note.createdAt, op.comparator, op.date)
          if (present === op.negated) {
            return false
          }
          break
        }
        case 'updated': {
          const present = compareDate(note.updatedAt, op.comparator, op.date)
          if (present === op.negated) {
            return false
          }
          break
        }
      }
    }

    return freeTextMatches(note, parsed.freeTextTerms, scope, caseSensitive)
  }
}
