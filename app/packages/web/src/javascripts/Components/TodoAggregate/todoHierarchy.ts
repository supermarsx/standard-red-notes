import type { PrefKey } from '@standardnotes/snjs'

/**
 * Standard Red Notes: heading-derived structure for the Todos view.
 *
 * Pure, application-free, Lexical-free: the classification of serialized block
 * nodes, the heading-section scan a parser runs over one container's children,
 * the depth-composition rule, and the two synced settings that gate the whole
 * behaviour. Nothing here throws — it runs against persisted note JSON written
 * by any version of the editor and against a synced preference another client
 * may have written.
 *
 * ## Why headings at all
 * A checklist carries only its own indentation, so every task in a document that
 * organises its work under `# Project` / `## Phase 1` came out at level 0: the
 * structure the user can see in the note was invisible in the Todos view. A
 * heading is the structure, so a heading opens a SECTION and the tasks beneath it
 * sit inside it.
 *
 * ## THE SERIALIZATION TRAP
 * Headings serialize under TWO type strings in this editor: `'heading'`
 * (Lexical's `HeadingNode`) and `'heading-styled'` (`StyledHeadingNode`, which
 * extends it). Paragraphs likewise: `'paragraph'` and `'paragraph-styled'`. The
 * live-editor outline builder never notices, because `$isHeadingNode` is an
 * instanceof test that matches the subclass for free — but a parser reading
 * persisted JSON has only the type STRING, and one that matches `'heading'`
 * alone misses most real headings in this editor. Both spellings are listed
 * below and {@link todoHierarchy.spec} pins each list against the node class's
 * own `getType()`, so a rename cannot silently strand one of them.
 */

/**
 * Deepest heading level that can establish a sublevel. `h1`..`h6` is the whole
 * range HTML and Lexical define, so this is the capability's natural ceiling
 * rather than a knob — the user asked for six levels, not for a number to tune.
 */
export const TODO_MAX_HEADING_LEVEL = 6

/** Serialized `type` of every heading node this editor can produce. */
export const TODO_HEADING_NODE_TYPES: readonly string[] = ['heading', 'heading-styled']

/** Serialized `type` of every paragraph node this editor can produce. */
export const TODO_PARAGRAPH_NODE_TYPES: readonly string[] = ['paragraph', 'paragraph-styled']

/**
 * One section description is one line of context, not a second document. Long
 * prose under a heading is truncated rather than allowed to dominate a table row.
 */
export const MAX_TODO_SECTION_DESCRIPTION_LENGTH = 1_024

/** How many consecutive paragraphs after a heading are read as its description. */
export const MAX_TODO_SECTION_DESCRIPTION_PARAGRAPHS = 8

export function isTodoHeadingNodeType(type: unknown): boolean {
  return typeof type === 'string' && TODO_HEADING_NODE_TYPES.includes(type)
}

export function isTodoParagraphNodeType(type: unknown): boolean {
  return typeof type === 'string' && TODO_PARAGRAPH_NODE_TYPES.includes(type)
}

/**
 * Heading level from a serialized `tag`, clamped into 1..{@link
 * TODO_MAX_HEADING_LEVEL}. An unreadable tag reads as level 1, exactly as the
 * live outline builder does (`Number(tag.slice(1)) || 1`), so the two never
 * disagree about the same heading.
 */
export function todoHeadingLevelFromTag(tag: unknown): number {
  const parsed = typeof tag === 'string' ? Number(tag.slice(1)) : Number.NaN
  if (!Number.isFinite(parsed)) {
    return 1
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), TODO_MAX_HEADING_LEVEL)
}

// ---------------------------------------------------------------------------
// The two settings
// ---------------------------------------------------------------------------

/**
 * Both keys are pinned as string literals rather than read off the `PrefKey`
 * enum object, for the reason `TODO_FILTERS_PREF_KEY` documents: web consumes the
 * enum's RUNTIME value from the generated snjs bundle, and a new member is absent
 * from it — and from its generated `.d.ts` — until that shared artifact is
 * rebuilt. A string enum is its own string at runtime, so these are exactly
 * `PrefKey.TodoHeadingLevels` / `PrefKey.TodoHeadingDescriptions`.
 *
 * The cast goes through `unknown` because the member does not exist in the
 * generated typings yet, so `as PrefKey.TodoHeadingLevels` does not compile.
 * SWAP BACK to the plain enum members (`PrefKey.TodoHeadingLevels`,
 * `PrefKey.TodoHeadingDescriptions`) once snjs has been rebuilt in a normal build
 * cycle; `models/src/.../PrefKey.ts` already declares both.
 */
export const TODO_HEADING_LEVELS_PREF_KEY = 'todoHeadingLevels' as unknown as PrefKey
export const TODO_HEADING_DESCRIPTIONS_PREF_KEY = 'todoHeadingDescriptions' as unknown as PrefKey

/**
 * Both default ON, and both defaults are HARDCODED LITERALS here rather than read
 * from `PrefDefaults[PrefKey.TodoHeadingLevels]`. That lookup is `undefined` at
 * runtime for the same reason the keys are pinned — the generated bundle predates
 * the member — and `undefined` is falsy, so reading the default from the table
 * would ship both features permanently OFF while looking exactly like "the
 * setting does nothing".
 */
export const DEFAULT_TODO_HEADING_LEVELS = true
export const DEFAULT_TODO_HEADING_DESCRIPTIONS = true

/**
 * How a note's checklist JSON is read into todo rows.
 *
 * `headingLevels` off means headings contribute nothing: no section rows, no
 * depth, no descriptions — byte for byte the behaviour that shipped before this
 * existed. `headingDescriptions` off keeps the sections and drops only their
 * description line. A description is a property OF a section, so there is nothing
 * for one to attach to while `headingLevels` is off; that is stated here because
 * it is a deliberate dependency rather than an oversight, and
 * {@link todoHierarchy.spec} pins it.
 */
export type TodoHierarchyOptions = {
  headingLevels: boolean
  headingDescriptions: boolean
}

export const DEFAULT_TODO_HIERARCHY_OPTIONS: TodoHierarchyOptions = {
  headingLevels: DEFAULT_TODO_HEADING_LEVELS,
  headingDescriptions: DEFAULT_TODO_HEADING_DESCRIPTIONS,
}

/**
 * Coerce the two persisted values. A boolean is honoured in both directions; a
 * value of any other shape — absent, a string from a future client, a corrupted
 * item — falls back to the shipped default rather than to `false`, because
 * `undefined` is falsy and silently reading it as "off" is precisely the failure
 * this normalizer exists to prevent.
 */
export function normalizeTodoHierarchyOptions(raw: {
  headingLevels?: unknown
  headingDescriptions?: unknown
}): TodoHierarchyOptions {
  return {
    headingLevels: typeof raw.headingLevels === 'boolean' ? raw.headingLevels : DEFAULT_TODO_HEADING_LEVELS,
    headingDescriptions:
      typeof raw.headingDescriptions === 'boolean' ? raw.headingDescriptions : DEFAULT_TODO_HEADING_DESCRIPTIONS,
  }
}

export function todoHierarchyOptionsEqual(a: TodoHierarchyOptions, b: TodoHierarchyOptions): boolean {
  return a.headingLevels === b.headingLevels && a.headingDescriptions === b.headingDescriptions
}

// ---------------------------------------------------------------------------
// What a row IS
// ---------------------------------------------------------------------------

/**
 * The shape these predicates test. Structural on purpose: `TodoItem` and
 * `SuperChecklistTodo` both satisfy it, and depending on neither keeps this
 * module importable from the parser that produces them.
 */
export type TodoItemKindFields = {
  /** 1..6 on a heading section row; absent on everything else. */
  headingLevel?: number
  /** Present only on the occurrence-summary record a generation pass writes. */
  occurrenceSummary?: unknown
}

/** True for a heading section row: context, never work. */
export function isTodoHeadingItem(item: TodoItemKindFields): boolean {
  return item.headingLevel !== undefined
}

/**
 * True for the occurrence-summary record.
 *
 * Tested through the normalized state the parser already resolved, which is the
 * serialized-JSON counterpart of `$isChecklistOccurrenceSummaryItem`'s node-state
 * test. Nothing here or anywhere else may identify that row by its WORDING: the
 * copy is user-visible prose that changes with locale and editing, and a text
 * match would start failing silently the first time either moves.
 */
export function isTodoOccurrenceSummaryItem(item: TodoItemKindFields): boolean {
  return item.occurrenceSummary !== undefined
}

/**
 * True for a row that represents WORK, and therefore the only kind of row that
 * may be counted, selected or bulk-acted on.
 *
 * A heading section is context the user authored to organise the list. An
 * occurrence summary is a record of what a capped generation pass did NOT write
 * down. Counting either corrupts the progress bar; selecting either would let
 * "Complete" or "Clear schedules" operate on something that is not a task.
 */
export function isCountableTodoItem(item: TodoItemKindFields): boolean {
  return !isTodoHeadingItem(item) && !isTodoOccurrenceSummaryItem(item)
}

// ---------------------------------------------------------------------------
// Depth composition
// ---------------------------------------------------------------------------

/**
 * The depth a row renders at.
 *
 * Two inputs, in this order of authority:
 *
 *  - **The parent chain.** A row whose parent is itself a visible row sits one
 *    level deeper than it, so the indentation always agrees with the links the
 *    tree is actually drawn from.
 *  - **The section floor.** The depth contributed by the enclosing heading
 *    sections. It is a FLOOR, not a replacement, for two reasons: a row whose own
 *    parent never became a row (a blank checklist item) must still sit inside the
 *    section it was authored in rather than jumping to the top; and a document
 *    that skips a heading level (`#` straight to `###`) must not have its `h3`
 *    flattened to depth 1 — the heading states its own level, and a child is
 *    never shallower than its parent.
 */
export function todoRowDepth(parentDepth: number | undefined, sectionDepth: number | undefined): number {
  const floor = sectionDepth !== undefined && Number.isFinite(sectionDepth) ? Math.max(sectionDepth, 0) : 0
  if (parentDepth === undefined) {
    return floor
  }
  return Math.max(parentDepth + 1, floor)
}

// ---------------------------------------------------------------------------
// The heading-section scan
// ---------------------------------------------------------------------------

/** One heading that opens a section, identified by its index in its container. */
export type TodoHeadingSection = {
  /** Index of the heading among its container's children. */
  index: number
  /** 1..{@link TODO_MAX_HEADING_LEVEL}. */
  level: number
  text: string
  /** The first run of paragraphs immediately after the heading, when enabled. */
  description?: string
}

export type TodoHeadingScan = {
  /** Sections opened in this container, keyed by child index, in document order. */
  headings: Map<number, TodoHeadingSection>
  /**
   * For each child index, the index of the innermost section opened in THIS
   * container that encloses it. Absent means "whatever section encloses the
   * container itself", which the caller already holds. For a heading child this
   * is the section the heading is nested in, not the one it opens.
   */
  enclosing: Map<number, number>
}

const EMPTY_SCAN: TodoHeadingScan = { headings: new Map(), enclosing: new Map() }

/**
 * Resolve the heading sections of ONE container's children.
 *
 * Deliberately per-container rather than document-global: a heading inside a
 * quote or a table cell organises that container, and letting it reach back out
 * to re-parent the document's top-level tasks would invent structure the user
 * cannot see. `readText` is supplied by the caller so the traversal budget stays
 * with the parser that owns it.
 *
 * ## An invisible section is not a section
 * A heading with no text is not opened. It cannot be rendered, so indenting the
 * tasks under it would claim a level with nothing on screen to explain it — the
 * same rule that keeps a missing parent from indenting its child. It still CLOSES
 * the sections it outranks, because an unnamed `# ` is still a break in the
 * document's structure.
 */
export function scanTodoHeadingSections(
  children: readonly unknown[],
  readText: (node: unknown) => string,
  options: TodoHierarchyOptions,
): TodoHeadingScan {
  if (!options.headingLevels || children.length === 0) {
    return EMPTY_SCAN
  }

  const headings = new Map<number, TodoHeadingSection>()
  const enclosing = new Map<number, number>()
  const open: Array<{ index: number; level: number }> = []

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const type = child && typeof child === 'object' ? (child as { type?: unknown }).type : undefined

    if (!isTodoHeadingNodeType(type)) {
      const innermost = open[open.length - 1]
      if (innermost) {
        enclosing.set(index, innermost.index)
      }
      continue
    }

    const level = todoHeadingLevelFromTag((child as { tag?: unknown }).tag)
    while (open.length > 0 && open[open.length - 1].level >= level) {
      open.pop()
    }
    const innermost = open[open.length - 1]
    if (innermost) {
      enclosing.set(index, innermost.index)
    }

    const text = readText(child).trim()
    if (text.length === 0) {
      continue
    }

    const description = options.headingDescriptions ? sectionDescription(children, index, readText) : undefined
    headings.set(index, { index, level, text, ...(description ? { description } : {}) })
    open.push({ index, level })
  }

  return { headings, enclosing }
}

/**
 * The first run of paragraphs immediately after a heading, joined into one line.
 *
 * The run ends at the first child that is not a paragraph — a list, another
 * heading, a table — so only text the user wrote directly under the heading is
 * taken. An EMPTY paragraph does not end the run: a blank line between a heading
 * and its intro is ordinary authoring, and treating it as a terminator would lose
 * the description for most real documents. Returns `undefined` when there is no
 * text, so the caller writes no field at all rather than an empty one.
 */
function sectionDescription(
  children: readonly unknown[],
  headingIndex: number,
  readText: (node: unknown) => string,
): string | undefined {
  const pieces: string[] = []
  let length = 0
  const limit = Math.min(children.length, headingIndex + 1 + MAX_TODO_SECTION_DESCRIPTION_PARAGRAPHS)

  for (let index = headingIndex + 1; index < limit; index += 1) {
    const child = children[index]
    const type = child && typeof child === 'object' ? (child as { type?: unknown }).type : undefined
    if (!isTodoParagraphNodeType(type)) {
      break
    }
    const text = readText(child).trim()
    if (text.length === 0) {
      continue
    }
    const piece = text.slice(0, MAX_TODO_SECTION_DESCRIPTION_LENGTH - length)
    pieces.push(piece)
    length += piece.length
    if (length >= MAX_TODO_SECTION_DESCRIPTION_LENGTH) {
      break
    }
  }

  const description = pieces.join(' ').trim()
  return description.length > 0 ? description : undefined
}
