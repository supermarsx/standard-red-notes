import { HeadingNode } from '@lexical/rich-text'
import { ParagraphNode } from 'lexical'
import { StyledHeadingNode, StyledParagraphNode } from '../SuperEditor/Lexical/Nodes/StyledBlockNodes'
import {
  DEFAULT_TODO_HEADING_DESCRIPTIONS,
  DEFAULT_TODO_HEADING_LEVELS,
  DEFAULT_TODO_HIERARCHY_OPTIONS,
  isCountableTodoItem,
  isTodoHeadingItem,
  isTodoHeadingNodeType,
  isTodoOccurrenceSummaryItem,
  isTodoParagraphNodeType,
  MAX_TODO_SECTION_DESCRIPTION_LENGTH,
  MAX_TODO_SECTION_DESCRIPTION_PARAGRAPHS,
  normalizeTodoHierarchyOptions,
  scanTodoHeadingSections,
  TODO_HEADING_DESCRIPTIONS_PREF_KEY,
  TODO_HEADING_LEVELS_PREF_KEY,
  TODO_HEADING_NODE_TYPES,
  TODO_MAX_HEADING_LEVEL,
  TODO_PARAGRAPH_NODE_TYPES,
  todoHeadingLevelFromTag,
  todoHierarchyOptionsEqual,
  todoRowDepth,
} from './todoHierarchy'

/**
 * The classification, the settings and the scan, with no document parser in the
 * way. `superChecklistDocument.spec` proves the same rules survive a real
 * serialized note; this proves the rules themselves.
 */

const text = (value: string) => ({ type: 'text', text: value })
const heading = (tag: string, label: string, type = 'heading') => ({ type, tag, children: [text(label)] })
const paragraph = (label: string, type = 'paragraph') => ({ type, children: label ? [text(label)] : [] })
const checkList = (children: unknown[]) => ({ type: 'list', listType: 'check', children })

/** The same shallow text read the parser hands the scan, minus its budget. */
const readText = (node: unknown): string => {
  const children = (node as { children?: unknown })?.children
  if (!Array.isArray(children)) {
    return ''
  }
  return children
    .map((child) => (typeof (child as { text?: unknown })?.text === 'string' ? (child as { text: string }).text : ''))
    .join('')
}

const scan = (children: unknown[], options = DEFAULT_TODO_HIERARCHY_OPTIONS) =>
  scanTodoHeadingSections(children, readText, options)

describe('serialized node classification', () => {
  /**
   * THE TRAP. `$isHeadingNode` is an instanceof test, so the live editor matches
   * `StyledHeadingNode` for free; a parser reading persisted JSON has only the
   * type STRING, and `'heading-styled'` is what most real headings in this editor
   * serialize as. Asserted against the node classes' own `getType()` so a rename
   * on either side breaks here instead of silently halving the feature.
   */
  it('accepts BOTH serialized spellings of a heading and of a paragraph', () => {
    expect(HeadingNode.getType()).toBe('heading')
    expect(StyledHeadingNode.getType()).toBe('heading-styled')
    expect(ParagraphNode.getType()).toBe('paragraph')
    expect(StyledParagraphNode.getType()).toBe('paragraph-styled')

    expect(TODO_HEADING_NODE_TYPES).toContain(HeadingNode.getType())
    expect(TODO_HEADING_NODE_TYPES).toContain(StyledHeadingNode.getType())
    expect(TODO_PARAGRAPH_NODE_TYPES).toContain(ParagraphNode.getType())
    expect(TODO_PARAGRAPH_NODE_TYPES).toContain(StyledParagraphNode.getType())

    expect(isTodoHeadingNodeType(HeadingNode.getType())).toBe(true)
    expect(isTodoHeadingNodeType(StyledHeadingNode.getType())).toBe(true)
    expect(isTodoParagraphNodeType(ParagraphNode.getType())).toBe(true)
    expect(isTodoParagraphNodeType(StyledParagraphNode.getType())).toBe(true)
  })

  it('classifies nothing else as a heading or a paragraph', () => {
    for (const type of ['list', 'listitem', 'quote', 'quote-styled', 'table', undefined, null, 42, '']) {
      expect(isTodoHeadingNodeType(type)).toBe(false)
      expect(isTodoParagraphNodeType(type)).toBe(false)
    }
  })

  it('reads the level off the tag, clamped into 1..6, and falls back exactly as the outline does', () => {
    expect(TODO_MAX_HEADING_LEVEL).toBe(6)
    expect([1, 2, 3, 4, 5, 6].map((level) => todoHeadingLevelFromTag(`h${level}`))).toEqual([1, 2, 3, 4, 5, 6])
    // Past the ceiling clamps rather than inventing a seventh level.
    expect(todoHeadingLevelFromTag('h9')).toBe(TODO_MAX_HEADING_LEVEL)
    // Unreadable tags read as level 1, which is what `Number(tag.slice(1)) || 1`
    // in the live outline builder does for the same node.
    for (const tag of [undefined, '', 'h', 'hx', 'heading', 7, null]) {
      expect(todoHeadingLevelFromTag(tag)).toBe(1)
    }
  })
})

describe('the two settings', () => {
  it('pins each key as the exact stored string', () => {
    // An `as unknown as PrefKey` cast is unchecked by construction, so the only
    // thing standing between a typo here and a setting that silently reads its
    // default forever is this assertion.
    expect(String(TODO_HEADING_LEVELS_PREF_KEY)).toBe('todoHeadingLevels')
    expect(String(TODO_HEADING_DESCRIPTIONS_PREF_KEY)).toBe('todoHeadingDescriptions')
  })

  it('defaults BOTH behaviours on, as literals', () => {
    // `PrefDefaults[PrefKey.TodoHeadingLevels]` is `undefined` at runtime until the
    // generated bundle is rebuilt, and `undefined` is falsy — reading the default
    // from there would ship both features permanently off while looking exactly
    // like "the setting does nothing".
    expect(DEFAULT_TODO_HEADING_LEVELS).toBe(true)
    expect(DEFAULT_TODO_HEADING_DESCRIPTIONS).toBe(true)
    expect(DEFAULT_TODO_HIERARCHY_OPTIONS).toEqual({ headingLevels: true, headingDescriptions: true })
  })

  it('falls back to the default rather than to false for any non-boolean', () => {
    expect(normalizeTodoHierarchyOptions({})).toEqual({ headingLevels: true, headingDescriptions: true })
    expect(normalizeTodoHierarchyOptions({ headingLevels: undefined, headingDescriptions: null })).toEqual({
      headingLevels: true,
      headingDescriptions: true,
    })
    expect(normalizeTodoHierarchyOptions({ headingLevels: 'off', headingDescriptions: 0 })).toEqual({
      headingLevels: true,
      headingDescriptions: true,
    })
  })

  it('honours an explicit boolean in both directions', () => {
    expect(normalizeTodoHierarchyOptions({ headingLevels: false, headingDescriptions: false })).toEqual({
      headingLevels: false,
      headingDescriptions: false,
    })
    expect(normalizeTodoHierarchyOptions({ headingLevels: true, headingDescriptions: false })).toEqual({
      headingLevels: true,
      headingDescriptions: false,
    })
  })

  it('compares by value, so adopting an unchanged synced value re-parses nothing', () => {
    expect(
      todoHierarchyOptionsEqual({ headingLevels: true, headingDescriptions: true }, DEFAULT_TODO_HIERARCHY_OPTIONS),
    ).toBe(true)
    expect(
      todoHierarchyOptionsEqual({ headingLevels: true, headingDescriptions: false }, DEFAULT_TODO_HIERARCHY_OPTIONS),
    ).toBe(false)
  })
})

describe('what a row is', () => {
  it('counts tasks only — a section is context and a summary is a record', () => {
    expect(isCountableTodoItem({})).toBe(true)
    expect(isTodoHeadingItem({ headingLevel: 2 })).toBe(true)
    expect(isCountableTodoItem({ headingLevel: 2 })).toBe(false)
    expect(isTodoOccurrenceSummaryItem({ occurrenceSummary: { missedCount: 3 } })).toBe(true)
    expect(isCountableTodoItem({ occurrenceSummary: { missedCount: 3 } })).toBe(false)
    // Level 0 is a real heading level after clamping, so presence is the test and
    // truthiness is not.
    expect(isTodoHeadingItem({ headingLevel: 0 })).toBe(true)
  })
})

describe('todoRowDepth', () => {
  it('derives depth from the parent chain when there is a parent row', () => {
    expect(todoRowDepth(0, 0)).toBe(1)
    expect(todoRowDepth(3, 0)).toBe(4)
  })

  it('uses the section as the depth of a row with no parent row', () => {
    expect(todoRowDepth(undefined, undefined)).toBe(0)
    expect(todoRowDepth(undefined, 2)).toBe(2)
  })

  it('treats the section as a FLOOR, never as an override', () => {
    // A document that skips a heading level (`#` straight to `###`) must not have
    // its h3 flattened to depth 1 by the chain…
    expect(todoRowDepth(0, 2)).toBe(2)
    // …and a deep subtask inside a shallow section must not be pulled back up.
    expect(todoRowDepth(5, 1)).toBe(6)
  })

  it('never returns a negative depth, whatever a corrupted value says', () => {
    expect(todoRowDepth(undefined, -4)).toBe(0)
    expect(todoRowDepth(undefined, Number.NaN)).toBe(0)
    expect(todoRowDepth(0, Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('treats the document’s own nesting as a floor too', () => {
    // The case that matters: no parent row could be resolved at all. Without the
    // structural floor a four-level checklist renders flush left and the user is
    // told their document has no structure.
    expect(todoRowDepth(undefined, undefined, 3)).toBe(3)
    expect(todoRowDepth(undefined, 1, 3)).toBe(3)
    // A floor, not an override: the chain still wins when it is deeper…
    expect(todoRowDepth(5, 0, 2)).toBe(6)
    // …and a structural depth of zero never pulls a nested row back up.
    expect(todoRowDepth(2, 0, 0)).toBe(3)
  })

  it('refuses a corrupted structural depth rather than indenting on it', () => {
    expect(todoRowDepth(undefined, undefined, -3)).toBe(0)
    expect(todoRowDepth(undefined, undefined, Number.NaN)).toBe(0)
    expect(todoRowDepth(undefined, 2, Number.NaN)).toBe(2)
  })
})

describe('scanTodoHeadingSections', () => {
  it('opens a section at each heading and encloses the siblings that follow it', () => {
    const children = [heading('h1', 'Project'), checkList([]), heading('h2', 'Phase 1'), checkList([]), paragraph('x')]
    const result = scan(children)

    expect([...result.headings.values()].map((section) => [section.index, section.level, section.text])).toEqual([
      [0, 1, 'Project'],
      [2, 2, 'Phase 1'],
    ])
    // The checklist after `# Project` is inside it; the one after `## Phase 1` is
    // inside the deeper section; and `## Phase 1` itself is inside `# Project`.
    expect(result.enclosing.get(1)).toBe(0)
    expect(result.enclosing.get(2)).toBe(0)
    expect(result.enclosing.get(3)).toBe(2)
    // Nothing precedes the first heading, so index 0 has no enclosing section.
    expect(result.enclosing.has(0)).toBe(false)
  })

  it('recognises a styled heading exactly as it recognises a plain one', () => {
    const plain = scan([heading('h2', 'Styled?', 'heading'), checkList([])])
    const styled = scan([heading('h2', 'Styled?', 'heading-styled'), checkList([])])
    expect([...styled.headings.values()]).toEqual([...plain.headings.values()])
    expect(styled.enclosing.get(1)).toBe(0)
  })

  it('closes the sections a heading outranks', () => {
    const result = scan([
      heading('h1', 'One'),
      heading('h3', 'Deep'),
      heading('h2', 'Back out'),
      checkList([]),
      heading('h1', 'Two'),
      checkList([]),
    ])
    // `## Back out` outranks `### Deep`, so it reopens under `# One`.
    expect(result.enclosing.get(2)).toBe(0)
    expect(result.enclosing.get(3)).toBe(2)
    // A second h1 closes everything before it.
    expect(result.enclosing.has(4)).toBe(false)
    expect(result.enclosing.get(5)).toBe(4)
  })

  it('does not open a section for a heading with no text, but still closes with it', () => {
    // A section the user cannot see must not indent what follows it — the same
    // rule that stops a missing parent indenting its child.
    const result = scan([heading('h1', 'Named'), checkList([]), heading('h1', '   '), checkList([])])
    expect([...result.headings.keys()]).toEqual([0])
    expect(result.enclosing.get(1)).toBe(0)
    // The unnamed h1 is still a break in the document, so what follows is outside
    // the first section rather than wrongly still inside it.
    expect(result.enclosing.has(3)).toBe(false)
  })

  it('reads the first run of paragraphs after a heading as its description', () => {
    const result = scan([
      heading('h1', 'Project'),
      paragraph('What this is about.'),
      paragraph('And a second line.'),
      checkList([]),
      // Past the list: no longer "immediately following" the heading.
      paragraph('Unrelated prose.'),
    ])
    expect(result.headings.get(0)?.description).toBe('What this is about. And a second line.')
  })

  it('accepts a styled paragraph as part of the description run', () => {
    const result = scan([heading('h1', 'Project'), paragraph('Styled prose.', 'paragraph-styled'), checkList([])])
    expect(result.headings.get(0)?.description).toBe('Styled prose.')
  })

  it('treats a blank line as part of the run, and any other node as its end', () => {
    expect(
      scan([heading('h1', 'A'), paragraph(''), paragraph('After a blank line.')]).headings.get(0)?.description,
    ).toBe('After a blank line.')
    // A list ends the run even when prose follows it.
    expect(
      scan([heading('h1', 'A'), checkList([]), paragraph('Not the description.')]).headings.get(0)?.description,
    ).toBeUndefined()
  })

  it('leaves the description ABSENT rather than empty when there is none', () => {
    expect(scan([heading('h1', 'A'), checkList([])]).headings.get(0)).not.toHaveProperty('description')
    expect(scan([heading('h1', 'A'), paragraph('  ')]).headings.get(0)).not.toHaveProperty('description')
  })

  it('bounds the description by length and by paragraph count', () => {
    const long = Array.from({ length: MAX_TODO_SECTION_DESCRIPTION_PARAGRAPHS + 4 }, (_, index) =>
      paragraph(`p${index}`),
    )
    const result = scan([heading('h1', 'A'), ...long])
    expect(result.headings.get(0)?.description).not.toContain(`p${MAX_TODO_SECTION_DESCRIPTION_PARAGRAPHS}`)

    const huge = scan([heading('h1', 'A'), paragraph('x'.repeat(MAX_TODO_SECTION_DESCRIPTION_LENGTH * 3))])
    expect(huge.headings.get(0)?.description?.length).toBe(MAX_TODO_SECTION_DESCRIPTION_LENGTH)
  })

  it('keeps the sections and drops only the descriptions when descriptions are off', () => {
    const children = [heading('h1', 'Project'), paragraph('Prose.'), checkList([])]
    const result = scan(children, { headingLevels: true, headingDescriptions: false })
    expect(result.headings.get(0)).toMatchObject({ level: 1, text: 'Project' })
    expect(result.headings.get(0)).not.toHaveProperty('description')
    expect(result.enclosing.get(2)).toBe(0)
  })

  it('finds nothing at all when heading levels are off', () => {
    const children = [heading('h1', 'Project'), paragraph('Prose.'), checkList([])]
    const result = scan(children, { headingLevels: false, headingDescriptions: true })
    expect(result.headings.size).toBe(0)
    expect(result.enclosing.size).toBe(0)
  })

  it('never throws on a malformed child list', () => {
    expect(() => scan([null, undefined, 7, 'text', {}, { type: 'heading' }])).not.toThrow()
    expect(scan([]).headings.size).toBe(0)
  })
})
