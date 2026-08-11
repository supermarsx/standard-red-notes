import { CHECKLIST_DUE_AT_STATE_KEY, CHECKLIST_TODO_ID_STATE_KEY } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
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
    })
    expect(items[1]).toMatchObject({ id: 'legacy-0.1', todoId: undefined, locator: '0.1', checked: true })
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
})
