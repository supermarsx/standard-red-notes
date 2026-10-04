import {
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY,
  CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
  CHECKLIST_RECURRENCE_STATE_KEY,
  CHECKLIST_SCHEDULE_STATE_KEY,
  CHECKLIST_SCHEDULE_VERSION,
  CHECKLIST_TODO_ID_STATE_KEY,
} from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import { createChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'
import { parseSuperChecklistDocument } from './superChecklistDocument'

const documentText = (): string =>
  JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          listType: 'check',
          children: [
            {
              type: 'listitem',
              $: {
                [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-alpha',
                [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T10:00:00+01:00',
                [CHECKLIST_RECURRENCE_STATE_KEY]: createChecklistRecurrence(
                  'weekly',
                  '2026-08-12T09:00:00.000Z',
                  'Europe/London',
                ),
              },
              checked: false,
              children: [{ type: 'text', text: 'Alpha' }],
            },
            {
              type: 'listitem',
              checked: true,
              children: [{ type: 'text', text: 'Legacy' }],
            },
          ],
        },
      ],
    },
  })

describe('Super checklist persisted document parsing', () => {
  it('extracts stable identity, legacy locator and canonical due time', () => {
    const items = parseSuperChecklistDocument(documentText())
    expect(items[0]).toMatchObject({
      id: 'todo-alpha',
      todoId: 'todo-alpha',
      locator: '0.0',
      dueAt: '2026-08-12T09:00:00.000Z',
      recurrence: expect.objectContaining({
        frequency: 'weekly',
        anchor: expect.objectContaining({ timeZone: 'Europe/London', hour: 10 }),
      }),
    })
    expect(items[1]).toMatchObject({ id: 'legacy-0.1', todoId: undefined, locator: '0.1', checked: true })
  })

  it('prefers the atomic schedule and fails closed when a present envelope is invalid', () => {
    const atomicDueAt = '2026-10-31T12:00:00.000Z'
    const atomicRule = createChecklistRecurrence('monthly', atomicDueAt, 'Europe/London')
    const text = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'list',
            listType: 'check',
            children: [
              {
                type: 'listitem',
                $: {
                  [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-atomic',
                  [CHECKLIST_SCHEDULE_STATE_KEY]: {
                    version: CHECKLIST_SCHEDULE_VERSION,
                    dueAt: atomicDueAt,
                    recurrence: atomicRule,
                  },
                  [CHECKLIST_DUE_AT_STATE_KEY]: '2020-01-01T00:00:00.000Z',
                  [CHECKLIST_RECURRENCE_STATE_KEY]: createChecklistRecurrence(
                    'daily',
                    '2020-01-01T00:00:00.000Z',
                    'UTC',
                  ),
                },
                checked: false,
                children: [{ type: 'text', text: 'Atomic' }],
              },
              {
                type: 'listitem',
                $: {
                  [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-future',
                  [CHECKLIST_SCHEDULE_STATE_KEY]: { version: 99, dueAt: atomicDueAt },
                  [CHECKLIST_DUE_AT_STATE_KEY]: '2020-01-01T00:00:00.000Z',
                },
                checked: false,
                children: [{ type: 'text', text: 'Future' }],
              },
            ],
          },
        ],
      },
    })

    const items = parseSuperChecklistDocument(text)
    expect(items[0]).toMatchObject({ dueAt: atomicDueAt, recurrence: { frequency: 'monthly' } })
    expect(items[1]).toMatchObject({ dueAt: undefined, recurrence: undefined })
  })

  it('emits nested tasks once without concatenating children or exposing structural wrappers', () => {
    const nested = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'list',
            listType: 'check',
            children: [
              {
                type: 'listitem',
                checked: false,
                children: [
                  { type: 'text', text: 'Parent' },
                  {
                    type: 'list',
                    listType: 'check',
                    children: [{ type: 'listitem', checked: false, children: [{ type: 'text', text: 'Child' }] }],
                  },
                ],
              },
              {
                type: 'listitem',
                children: [
                  {
                    type: 'list',
                    listType: 'check',
                    children: [
                      { type: 'listitem', checked: true, children: [{ type: 'text', text: 'Wrapped child' }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(parseSuperChecklistDocument(nested).map(({ text, locator }) => ({ text, locator }))).toEqual([
      { text: 'Parent', locator: '0.0' },
      { text: 'Child', locator: '0.0.1.0' },
      { text: 'Wrapped child', locator: '0.1.0.0' },
    ])
  })

  it('does not let metadata on an empty structural wrapper poison a semantic child identity', () => {
    const nested = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'list',
            listType: 'check',
            children: [
              {
                type: 'listitem',
                $: { [CHECKLIST_TODO_ID_STATE_KEY]: 'shared-id' },
                children: [
                  {
                    type: 'list',
                    listType: 'check',
                    children: [
                      {
                        type: 'listitem',
                        $: { [CHECKLIST_TODO_ID_STATE_KEY]: 'shared-id' },
                        children: [{ type: 'text', text: 'Real child' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(parseSuperChecklistDocument(nested)).toEqual([
      expect.objectContaining({ text: 'Real child', todoId: 'shared-id', id: 'shared-id' }),
    ])
  })

  it('fails closed for malformed content and duplicate stable identities', () => {
    expect(parseSuperChecklistDocument('not-json')).toEqual([])
    const duplicated = documentText().replace(
      '"checked":true,"children"',
      `"$":{"${CHECKLIST_TODO_ID_STATE_KEY}":"todo-alpha"},"checked":true,"children"`,
    )
    expect(parseSuperChecklistDocument(duplicated).every((item) => item.todoId === undefined)).toBe(true)
  })

  it('reports each task nesting level and the task it is nested under', () => {
    const text = (value: string) => ({ type: 'text', text: value })
    const checkList = (children: unknown[]) => ({ type: 'list', listType: 'check', children })
    const nested = JSON.stringify({
      root: {
        type: 'root',
        children: [
          checkList([
            {
              type: 'listitem',
              checked: false,
              children: [
                text('Parent'),
                checkList([
                  {
                    type: 'listitem',
                    checked: false,
                    children: [
                      text('Child'),
                      checkList([{ type: 'listitem', checked: false, children: [text('Grandchild')] }]),
                    ],
                  },
                ]),
              ],
            },
            { type: 'listitem', checked: false, children: [text('Sibling')] },
          ]),
        ],
      },
    })

    const parsed = parseSuperChecklistDocument(nested)
    expect(parsed.map((todo) => [todo.text, todo.depth])).toEqual([
      ['Parent', 0],
      ['Child', 1],
      ['Grandchild', 2],
      ['Sibling', 0],
    ])
    const byText = new Map(parsed.map((todo) => [todo.text, todo]))
    expect(byText.get('Parent')?.parentLocator).toBeUndefined()
    expect(byText.get('Child')?.parentLocator).toBe(byText.get('Parent')?.locator)
    expect(byText.get('Grandchild')?.parentLocator).toBe(byText.get('Child')?.locator)
    expect(byText.get('Sibling')?.parentLocator).toBeUndefined()
  })

  it('does not count a non-checklist wrapper as a nesting level', () => {
    // A checklist inside a quote is deeper in the TREE without being a deeper
    // task; reporting the tree depth here would indent it for no reason.
    const wrapped = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'quote',
            children: [
              {
                type: 'list',
                listType: 'check',
                children: [{ type: 'listitem', checked: false, children: [{ type: 'text', text: 'Quoted task' }] }],
              },
            ],
          },
        ],
      },
    })

    expect(parseSuperChecklistDocument(wrapped)).toEqual([
      expect.objectContaining({ text: 'Quoted task', depth: 0, parentLocator: undefined }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Heading sections
// ---------------------------------------------------------------------------

const textNode = (value: string) => ({ type: 'text', text: value })
const task = (label: string, children: unknown[] = []) => ({
  type: 'listitem',
  checked: false,
  children: [textNode(label), ...children],
})
const checkList = (children: unknown[]) => ({ type: 'list', listType: 'check', children })
const headingNode = (tag: string, label: string, type = 'heading') => ({ type, tag, children: [textNode(label)] })
const paragraphNode = (label: string, type = 'paragraph') => ({ type, children: [textNode(label)] })
const document = (children: unknown[]) => JSON.stringify({ root: { type: 'root', children } })

const shape = (items: ReturnType<typeof parseSuperChecklistDocument>) =>
  items.map((item) => [item.text, item.depth, item.headingLevel] as const)

describe('heading sections in a persisted document', () => {
  it('makes a heading a section and adds its level to the tasks beneath it', () => {
    const parsed = parseSuperChecklistDocument(
      document([
        headingNode('h1', 'Project'),
        checkList([task('Task A', [checkList([task('Sub A1')])])]),
        headingNode('h2', 'Phase 1'),
        checkList([task('Task B')]),
      ]),
    )

    // Section base plus checklist nesting: `# Project` puts Task A at 1 and its
    // own subtask at 2; `## Phase 1` is itself at 1 and its task at 2.
    expect(shape(parsed)).toEqual([
      ['Project', 0, 1],
      ['Task A', 1, undefined],
      ['Sub A1', 2, undefined],
      ['Phase 1', 1, 2],
      ['Task B', 2, undefined],
    ])
  })

  it('reads a STYLED heading identically to a plain one', () => {
    // The whole feature halves silently if only `'heading'` is matched: most real
    // headings in this editor serialize as `'heading-styled'`.
    const plain = parseSuperChecklistDocument(
      document([headingNode('h2', 'Phase 1', 'heading'), checkList([task('Task B')])]),
    )
    const styled = parseSuperChecklistDocument(
      document([headingNode('h2', 'Phase 1', 'heading-styled'), checkList([task('Task B')])]),
    )

    expect(shape(styled)).toEqual([
      ['Phase 1', 1, 2],
      ['Task B', 2, undefined],
    ])
    expect(shape(styled)).toEqual(shape(plain))
  })

  it('carries all six levels, and clamps a deeper tag rather than inventing a seventh', () => {
    const parsed = parseSuperChecklistDocument(
      document([
        ...[1, 2, 3, 4, 5, 6].flatMap((level) => [
          headingNode(`h${level}`, `H${level}`),
          checkList([task(`Task ${level}`)]),
        ]),
        headingNode('h9', 'Too deep'),
        checkList([task('Task 9')]),
      ]),
    )

    const byText = new Map(parsed.map((item) => [item.text, item]))
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(byText.get(`H${level}`)?.headingLevel).toBe(level)
      expect(byText.get(`H${level}`)?.depth).toBe(level - 1)
      expect(byText.get(`Task ${level}`)?.depth).toBe(level)
    }
    expect(byText.get('Too deep')?.headingLevel).toBe(6)
    expect(byText.get('Task 9')?.depth).toBe(6)
  })

  it('does not flatten a skipped heading level', () => {
    const parsed = parseSuperChecklistDocument(
      document([headingNode('h1', 'One'), headingNode('h3', 'Three'), checkList([task('Deep task')])]),
    )
    const byText = new Map(parsed.map((item) => [item.text, item]))
    // `### Three` states level 3 even though its parent chain is only one deep.
    expect(byText.get('Three')?.depth).toBe(2)
    expect(byText.get('Three')?.parentLocator).toBe(byText.get('One')?.locator)
    expect(byText.get('Deep task')?.depth).toBe(3)
  })

  it('parents a section’s top-level tasks on the heading, and nested ones on their task', () => {
    const parsed = parseSuperChecklistDocument(
      document([headingNode('h1', 'Project'), checkList([task('Task A', [checkList([task('Sub A1')])])])]),
    )
    const byText = new Map(parsed.map((item) => [item.text, item]))
    expect(byText.get('Project')?.parentLocator).toBeUndefined()
    expect(byText.get('Task A')?.parentLocator).toBe(byText.get('Project')?.locator)
    expect(byText.get('Sub A1')?.parentLocator).toBe(byText.get('Task A')?.locator)
  })

  it('leaves a task before the first heading exactly where it was', () => {
    const parsed = parseSuperChecklistDocument(
      document([checkList([task('Loose task')]), headingNode('h1', 'Project'), checkList([task('Task A')])]),
    )
    const byText = new Map(parsed.map((item) => [item.text, item]))
    expect(byText.get('Loose task')).toMatchObject({ depth: 0, sectionDepth: 0, parentLocator: undefined })
  })

  it('drops a section that owns no row, so a note with headings and no checklist stays out', () => {
    // Without this every Super note holding a heading would appear in the Todos
    // view as a page of section headers with nothing under them.
    expect(
      parseSuperChecklistDocument(document([headingNode('h1', 'Just prose'), paragraphNode('Nothing to do.')])),
    ).toEqual([])

    const parsed = parseSuperChecklistDocument(
      document([
        headingNode('h1', 'Empty section'),
        paragraphNode('Described but unused.'),
        headingNode('h1', 'Real section'),
        checkList([task('Task A')]),
      ]),
    )
    expect(parsed.map((item) => item.text)).toEqual(['Real section', 'Task A'])
  })

  it('keeps the ancestors of a section that does own rows', () => {
    const parsed = parseSuperChecklistDocument(
      document([headingNode('h1', 'Outer'), headingNode('h2', 'Inner'), checkList([task('Task A')])]),
    )
    expect(parsed.map((item) => item.text)).toEqual(['Outer', 'Inner', 'Task A'])
  })

  it('does not let an unnamed heading indent anything', () => {
    const parsed = parseSuperChecklistDocument(document([headingNode('h1', '   '), checkList([task('Task A')])]))
    expect(shape(parsed)).toEqual([['Task A', 0, undefined]])
  })

  it('scopes a heading inside a quote to that quote', () => {
    const parsed = parseSuperChecklistDocument(
      document([
        { type: 'quote', children: [headingNode('h2', 'Quoted section'), checkList([task('Quoted task')])] },
        checkList([task('Outside task')]),
      ]),
    )
    const byText = new Map(parsed.map((item) => [item.text, item]))
    expect(byText.get('Quoted task')?.depth).toBe(2)
    // The quote's heading must not reach back out and re-parent the document.
    expect(byText.get('Outside task')).toMatchObject({ depth: 0, parentLocator: undefined })
  })
})

describe('heading section descriptions', () => {
  const described = (paragraphType = 'paragraph') =>
    parseSuperChecklistDocument(
      document([
        headingNode('h1', 'Project'),
        paragraphNode('What this is about.', paragraphType),
        paragraphNode('And a second line.', paragraphType),
        checkList([task('Task A')]),
      ]),
    )

  it('turns the text after a heading into that section’s description', () => {
    expect(described()[0]).toMatchObject({
      text: 'Project',
      headingLevel: 1,
      description: 'What this is about. And a second line.',
    })
  })

  it('reads a STYLED paragraph as description text too', () => {
    expect(described('paragraph-styled')[0].description).toBe('What this is about. And a second line.')
  })

  it('attaches the description to the SECTION and never to the tasks', () => {
    const parsed = described()
    expect(parsed.find((item) => item.text === 'Task A')).not.toHaveProperty('description')
  })

  it('writes no description field at all when a section has none', () => {
    const parsed = parseSuperChecklistDocument(document([headingNode('h1', 'Project'), checkList([task('Task A')])]))
    expect(parsed[0]).not.toHaveProperty('description')
  })
})

describe('the hierarchy settings', () => {
  const text = document([
    headingNode('h1', 'Project'),
    paragraphNode('Prose.'),
    checkList([task('Task A', [checkList([task('Sub A1')])])]),
  ])

  it('behaves exactly as before heading sections existed when levels are off', () => {
    const parsed = parseSuperChecklistDocument(text, { headingLevels: false, headingDescriptions: true })
    expect(shape(parsed)).toEqual([
      ['Task A', 0, undefined],
      ['Sub A1', 1, undefined],
    ])
    expect(parsed.every((item) => item.description === undefined)).toBe(true)
    expect(parsed.map((item) => item.parentLocator)).toEqual([undefined, parsed[0].locator])
  })

  it('keeps the sublevels and drops only the description line when descriptions are off', () => {
    const parsed = parseSuperChecklistDocument(text, { headingLevels: true, headingDescriptions: false })
    expect(shape(parsed)).toEqual([
      ['Project', 0, 1],
      ['Task A', 1, undefined],
      ['Sub A1', 2, undefined],
    ])
    expect(parsed[0]).not.toHaveProperty('description')
  })

  it('does both by default, because an absent preference must not read as off', () => {
    expect(shape(parseSuperChecklistDocument(text))).toEqual([
      ['Project', 0, 1],
      ['Task A', 1, undefined],
      ['Sub A1', 2, undefined],
    ])
    expect(parseSuperChecklistDocument(text)[0].description).toBe('Prose.')
  })
})

describe('the occurrence-summary record', () => {
  const summary = {
    version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
    missedCount: 34,
    oldestMissedAt: '2025-02-16T09:00:00.000Z',
    newestMissedAt: '2025-11-14T09:00:00.000Z',
    sourceTodoId: 'todo-recurring',
  }

  const withSummary = (state: unknown, label = '34 earlier occurrences were not generated.') =>
    parseSuperChecklistDocument(
      document([
        checkList([
          { type: 'listitem', checked: false, children: [textNode('Water the plants')] },
          {
            type: 'listitem',
            checked: false,
            $: { [CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY]: state },
            children: [textNode(label)],
          },
        ]),
      ]),
    )

  it('reads the record out of the node state, exactly as it reads the todo id', () => {
    const parsed = withSummary(summary)
    expect(parsed[0]).not.toHaveProperty('occurrenceSummary')
    expect(parsed[1].occurrenceSummary).toEqual(summary)
  })

  it('fails closed on an unresolvable record rather than inventing a half one', () => {
    for (const broken of [
      { ...summary, version: 99 },
      { ...summary, missedCount: 0 },
      { ...summary, oldestMissedAt: 'not-a-date' },
      // Reversed bounds: a range it cannot support.
      { ...summary, oldestMissedAt: summary.newestMissedAt, newestMissedAt: summary.oldestMissedAt },
      'nonsense',
      null,
    ]) {
      expect(withSummary(broken)[1]).not.toHaveProperty('occurrenceSummary')
    }
  })

  it('keeps the record row even with no label, because its words come from the record', () => {
    const parsed = withSummary(summary, '')
    expect(parsed).toHaveLength(2)
    expect(parsed[1].occurrenceSummary).toEqual(summary)
  })
})
