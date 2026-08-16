import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot, $isTextNode } from 'lexical'
import {
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $getChecklistTodoId,
  $normalizeChecklistItemMetadata,
  $setChecklistTodoId,
  $setChecklistDueAt,
  $setChecklistRecurrence,
} from '../Lexical/Nodes/ChecklistItemNode'
import {
  $applyChecklistEditorMutation,
  $getChecklistScheduleSnapshot,
  $getChecklistItems,
  $setChecklistItemScheduleIfCurrent,
  canAttemptRecurringChecklistCompletion,
} from './ChecklistEditorMutations'
import { createChecklistRecurrence } from './checklistRecurrence'

const createEditor = () =>
  createHeadlessEditor({
    namespace: 'checklist-editor-mutation-test',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

describe('active checklist editor mutations', () => {
  it('updates the uniquely identified Lexical owner item', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistTodoId(item, 'todo-active-one')
        item.append($createTextNode('Deploy'))
        list.append(item)
        $getRoot().append(list)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect(
          $applyChecklistEditorMutation(
            { todoId: 'todo-active-one', locator: '0.0', text: 'Deploy', checked: false },
            { checked: true, dueAt: '2026-08-12T12:00:00.000Z' },
          ),
        ).toMatchObject({ matched: true, changed: true, todoId: 'todo-active-one' })
        expect($getChecklistItems()[0].getChecked()).toBe(true)
        expect($getChecklistDueAt($getChecklistItems()[0])).toBe('2026-08-12T12:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('migrates an exact legacy locator and rejects a moved locator', () => {
    const editor = createEditor()
    editor.setEditorState(
      editor.parseEditorState(
        JSON.stringify({
          root: {
            type: 'root',
            version: 1,
            format: '',
            indent: 0,
            direction: null,
            children: [
              {
                type: 'list',
                version: 1,
                listType: 'check',
                tag: 'ul',
                start: 1,
                format: '',
                indent: 0,
                direction: null,
                children: [
                  {
                    type: 'listitem',
                    version: 1,
                    value: 1,
                    checked: false,
                    format: '',
                    indent: 0,
                    direction: null,
                    children: [
                      { type: 'text', version: 1, text: 'Legacy', format: 0, detail: 0, mode: 'normal', style: '' },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ),
    )

    editor.update(
      () => {
        expect(
          $applyChecklistEditorMutation(
            { locator: '9.9', text: 'Legacy', checked: false },
            { checked: true, ensureTodoId: 'todo-wrong-locator' },
          ).matched,
        ).toBe(false)
        expect(
          $applyChecklistEditorMutation(
            { locator: '0.0', text: 'Legacy', checked: false },
            { checked: true, ensureTodoId: 'todo-migrated' },
          ),
        ).toMatchObject({ matched: true, changed: true, todoId: 'todo-migrated' })
      },
      { discrete: true },
    )
  })

  it('rejects legacy identity preparation when duplicate-text rows reorder under the open request', () => {
    const editor = createEditor()
    const firstDueAt = '2026-08-16T09:00:00.000Z'
    const secondDueAt = '2026-08-17T09:00:00.000Z'
    editor.update(
      () => {
        const first = $createListItemNode(false).append($createTextNode('Same label'))
        const second = $createListItemNode(false).append($createTextNode('Same label'))
        $setChecklistDueAt(first, firstDueAt)
        $setChecklistDueAt(second, secondDueAt)
        $getRoot().append($createListNode('check').append(first, second))

        const openRequest = {
          locator: '0.0',
          text: 'Same label',
          checked: false,
          dueAt: firstDueAt,
          recurrence: undefined,
        }
        first.insertBefore(second)

        expect($applyChecklistEditorMutation(openRequest, { ensureTodoId: 'todo-captured-before-reorder' })).toEqual({
          matched: false,
          changed: false,
        })
        expect($getChecklistTodoId(first)).toBeUndefined()
        expect($getChecklistTodoId(second)).toBeUndefined()
      },
      { discrete: true },
    )
  })

  it('adopts the unique ID assigned by cold-mount normalization for a stale legacy target', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        item.append($createTextNode('Normalized before bridge'))
        list.append(item)
        $getRoot().append(list)
        expect($normalizeChecklistItemMetadata()).toBe(1)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const normalizedId = $getChecklistTodoId($getChecklistItems()[0])
        expect(normalizedId).toMatch(/^todo-/)
        expect(
          $applyChecklistEditorMutation(
            { locator: '0.0', text: 'Normalized before bridge', checked: false },
            { checked: true, ensureTodoId: 'todo-generated-by-stale-row' },
          ),
        ).toMatchObject({ matched: true, changed: true, todoId: normalizedId })
        expect($getChecklistTodoId($getChecklistItems()[0])).toBe(normalizedId)
        expect($getChecklistItems()[0].getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })

  it('fails closed when a normalized legacy match carries an ambiguous duplicate ID', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const first = $createListItemNode(false).append($createTextNode('First'))
        const second = $createListItemNode(false).append($createTextNode('Second'))
        $setChecklistTodoId(first, 'todo-duplicate-normalized')
        $setChecklistTodoId(second, 'todo-duplicate-normalized')
        list.append(first, second)
        $getRoot().append(list)

        expect(
          $applyChecklistEditorMutation(
            { locator: '0.0', text: 'First', checked: false },
            { checked: true, ensureTodoId: 'todo-generated-by-stale-row' },
          ),
        ).toEqual({ matched: false, changed: false })
        expect(first.getChecked()).toBe(false)
        expect($getChecklistTodoId(first)).toBe('todo-duplicate-normalized')
        expect($getChecklistTodoId(second)).toBe('todo-duplicate-normalized')
      },
      { discrete: true },
    )
  })

  it('targets nested parent and child tasks but never structural wrapper listitems', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const rootList = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Parent'))
        const childList = $createListNode('check')
        const child = $createListItemNode(false)
        child.append($createTextNode('Child'))
        childList.append(child)
        parent.append(childList)

        const wrapper = $createListItemNode()
        const wrappedList = $createListNode('check')
        const wrappedChild = $createListItemNode(true)
        wrappedChild.append($createTextNode('Wrapped child'))
        wrappedList.append(wrappedChild)
        wrapper.append(wrappedList)
        rootList.append(parent, wrapper)
        $getRoot().append(rootList)

        expect($getChecklistItems()).toEqual([parent, child, wrappedChild])
        expect(
          $applyChecklistEditorMutation(
            { locator: '0.0', text: 'Parent', checked: false },
            { ensureTodoId: 'todo-nested-parent', checked: true },
          ),
        ).toMatchObject({ matched: true, changed: true, todoId: 'todo-nested-parent' })
        expect($getChecklistTodoId(parent)).toBe('todo-nested-parent')
        expect($getChecklistTodoId(child)).toBeDefined()
        expect($getChecklistTodoId(wrappedChild)).toBeDefined()
        expect($getChecklistTodoId(wrapper)).toBeUndefined()
        expect($normalizeChecklistItemMetadata()).toBe(0)
      },
      { discrete: true },
    )
  })

  it('rejects an invalid combined patch atomically before changing identity or checked state', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistTodoId(item, 'todo-atomic')
        item.append($createTextNode('Atomic'))
        list.append(item)
        $getRoot().append(list)

        expect(
          $applyChecklistEditorMutation(
            { todoId: 'todo-atomic', locator: '0.0', text: 'Atomic', checked: false },
            { ensureTodoId: 'todo-replaced', checked: true, dueAt: '2026-02-30T12:00:00Z' },
          ),
        ).toEqual({ matched: false, changed: false })
        expect($getChecklistTodoId(item)).toBe('todo-atomic')
        expect(item.getChecked()).toBe(false)
        expect($getChecklistDueAt(item)).toBeUndefined()
      },
      { discrete: true },
    )
  })

  it('atomically advances the same recurring row and rejects a duplicate stale completion', () => {
    const editor = createEditor()
    const recurrence = createChecklistRecurrence('daily', '2026-08-01T09:00:00.000Z', 'UTC')!
    const target = {
      todoId: 'todo-recurring',
      locator: '0.0',
      text: 'Recurring',
      checked: false,
      dueAt: '2026-08-01T09:00:00.000Z',
      recurrence,
    }
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Recurring'))
        $setChecklistTodoId(item, 'todo-recurring')
        $setChecklistDueAt(item, target.dueAt)
        $setChecklistRecurrence(item, recurrence)
        $getRoot().append($createListNode('check').append(item))

        expect($applyChecklistEditorMutation(target, { checked: true }, Date.parse('2026-08-05T12:00Z'))).toMatchObject(
          { matched: true, changed: true },
        )
        expect(item.getChecked()).toBe(false)
        expect($getChecklistDueAt(item)).toBe('2026-08-06T09:00:00.000Z')
        expect($getChecklistRecurrence(item)).toEqual(recurrence)

        expect($applyChecklistEditorMutation(target, { checked: true }, Date.parse('2026-08-05T12:00Z'))).toEqual({
          matched: false,
          changed: false,
        })
        expect($getChecklistDueAt(item)).toBe('2026-08-06T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('unchecks without rewinding a recurring deadline', () => {
    const editor = createEditor()
    const recurrence = createChecklistRecurrence('weekly', '2026-08-16T09:00:00.000Z', 'UTC')!
    editor.update(
      () => {
        const item = $createListItemNode(true).append($createTextNode('Legacy checked recurrence'))
        $setChecklistTodoId(item, 'todo-reopen')
        $setChecklistDueAt(item, '2026-08-16T09:00:00.000Z')
        $setChecklistRecurrence(item, recurrence)
        item.setChecked(true)
        $getRoot().append($createListNode('check').append(item))

        expect(
          $applyChecklistEditorMutation(
            {
              todoId: 'todo-reopen',
              locator: '0.0',
              text: 'Legacy checked recurrence',
              checked: true,
              dueAt: '2026-08-16T09:00:00.000Z',
              recurrence,
            },
            { checked: false },
            Date.parse('2026-09-01T00:00Z'),
          ),
        ).toMatchObject({ matched: true, changed: true })
        expect(item.getChecked()).toBe(false)
        expect($getChecklistDueAt(item)).toBe('2026-08-16T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it.each(['inline', 'aggregate'] as const)(
    'reopens a checked task when a recurring schedule is added through the %s editor',
    (editorPath) => {
      const editor = createEditor()
      const dueAt = '2026-08-16T09:00:00.000Z'
      const recurrence = createChecklistRecurrence('weekly', dueAt, 'UTC')!
      editor.update(
        () => {
          const item = $createListItemNode(true).append($createTextNode('Activate recurrence'))
          $setChecklistTodoId(item, 'todo-activate-recurrence')
          $setChecklistDueAt(item, dueAt)
          $getRoot().append($createListNode('check').append(item))

          const result =
            editorPath === 'inline'
              ? $setChecklistItemScheduleIfCurrent(item, { dueAt }, dueAt, recurrence)
              : $applyChecklistEditorMutation(
                  {
                    todoId: 'todo-activate-recurrence',
                    locator: '0.0',
                    text: 'Activate recurrence',
                    checked: true,
                    dueAt,
                  },
                  { recurrence },
                )
          expect(result).toMatchObject({ matched: true, changed: true })
          expect(item.getChecked()).toBe(false)
          expect($getChecklistDueAt(item)).toBe(dueAt)
          expect($getChecklistRecurrence(item)).toEqual(recurrence)
        },
        { discrete: true },
      )
    },
  )

  it('atomically re-anchors an existing recurrence when its due date changes', () => {
    const editor = createEditor()
    const recurrence = createChecklistRecurrence('monthly', '2026-01-31T09:00:00.000Z', 'Europe/London')!
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Re-anchor'))
        $setChecklistTodoId(item, 'todo-reanchor')
        $setChecklistDueAt(item, '2026-01-31T09:00:00.000Z')
        $setChecklistRecurrence(item, recurrence)
        $getRoot().append($createListNode('check').append(item))

        expect(
          $applyChecklistEditorMutation(
            {
              todoId: 'todo-reanchor',
              locator: '0.0',
              text: 'Re-anchor',
              checked: false,
              dueAt: '2026-01-31T09:00:00.000Z',
              recurrence,
            },
            { dueAt: '2026-04-30T08:00:00.000Z' },
          ),
        ).toMatchObject({ matched: true, changed: true })
        expect($getChecklistDueAt(item)).toBe('2026-04-30T08:00:00.000Z')
        expect($getChecklistRecurrence(item)?.anchor).toMatchObject({
          timeZone: 'Europe/London',
          year: 2026,
          month: 4,
          day: 30,
          hour: 9,
        })
      },
      { discrete: true },
    )
  })

  it('clears a due date and its recurrence together even when the patch omits the redundant rule clear', () => {
    const editor = createEditor()
    const dueAt = '2026-08-16T09:00:00.000Z'
    const recurrence = createChecklistRecurrence('weekly', dueAt, 'UTC')!
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Clear schedule'))
        $setChecklistTodoId(item, 'todo-clear-schedule')
        $setChecklistDueAt(item, dueAt)
        $setChecklistRecurrence(item, recurrence)
        $getRoot().append($createListNode('check').append(item))

        expect(
          $applyChecklistEditorMutation(
            {
              todoId: 'todo-clear-schedule',
              locator: '0.0',
              text: 'Clear schedule',
              checked: false,
              dueAt,
              recurrence,
            },
            { dueAt: null },
          ),
        ).toMatchObject({ matched: true, changed: true })
        expect($getChecklistDueAt(item)).toBeUndefined()
        expect($getChecklistRecurrence(item)).toBeUndefined()
      },
      { discrete: true },
    )
  })

  it('rejects a stale aggregate schedule save instead of overwriting a newer rule', () => {
    const editor = createEditor()
    const originalDueAt = '2026-08-16T09:00:00.000Z'
    const originalRecurrence = createChecklistRecurrence('weekly', originalDueAt, 'UTC')!
    const liveDueAt = '2026-08-17T09:00:00.000Z'
    const liveRecurrence = createChecklistRecurrence('daily', liveDueAt, 'UTC')!
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Concurrent schedule'))
        $setChecklistTodoId(item, 'todo-concurrent-schedule')
        $setChecklistDueAt(item, liveDueAt)
        $setChecklistRecurrence(item, liveRecurrence)
        $getRoot().append($createListNode('check').append(item))

        const staleReplacementDueAt = '2026-09-01T09:00:00.000Z'
        expect(
          $applyChecklistEditorMutation(
            {
              todoId: 'todo-concurrent-schedule',
              locator: '0.0',
              text: 'Concurrent schedule',
              checked: false,
              dueAt: originalDueAt,
              recurrence: originalRecurrence,
            },
            {
              dueAt: staleReplacementDueAt,
              recurrence: createChecklistRecurrence('monthly', staleReplacementDueAt, 'UTC'),
            },
          ),
        ).toEqual({ matched: false, changed: false })
        expect($getChecklistDueAt(item)).toBe(liveDueAt)
        expect($getChecklistRecurrence(item)).toEqual(liveRecurrence)
      },
      { discrete: true },
    )
  })

  it('rejects an inline schedule draft when live state changed after the panel opened', () => {
    const editor = createEditor()
    const originalDueAt = '2026-08-16T09:00:00.000Z'
    const originalRecurrence = createChecklistRecurrence('weekly', originalDueAt, 'UTC')!
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Inline conflict'))
        $setChecklistTodoId(item, 'todo-inline-conflict')
        $setChecklistDueAt(item, originalDueAt)
        $setChecklistRecurrence(item, originalRecurrence)
        $getRoot().append($createListNode('check').append(item))

        const openTimeSnapshot = $getChecklistScheduleSnapshot(item)
        const remoteDueAt = '2026-08-17T09:00:00.000Z'
        const remoteRecurrence = createChecklistRecurrence('daily', remoteDueAt, 'UTC')!
        $setChecklistDueAt(item, remoteDueAt)
        $setChecklistRecurrence(item, remoteRecurrence)

        const draftDueAt = '2026-09-01T09:00:00.000Z'
        expect(
          $setChecklistItemScheduleIfCurrent(
            item,
            openTimeSnapshot,
            draftDueAt,
            createChecklistRecurrence('monthly', draftDueAt, 'UTC'),
          ),
        ).toEqual({ matched: false, changed: false })
        expect($getChecklistDueAt(item)).toBe(remoteDueAt)
        expect($getChecklistRecurrence(item)).toEqual(remoteRecurrence)
      },
      { discrete: true },
    )
  })

  it('blocks a rapid second recurring completion attempt at the interaction boundary', () => {
    expect(canAttemptRecurringChecklistCompletion(undefined, 1_000)).toBe(true)
    expect(canAttemptRecurringChecklistCompletion(1_000, 1_200)).toBe(false)
    expect(canAttemptRecurringChecklistCompletion(1_000, 1_750)).toBe(true)
    expect(canAttemptRecurringChecklistCompletion(undefined, 2_000, undefined, true)).toBe(false)
  })

  it.each(['typing-first', 'todo-first'] as const)(
    'preserves pending visible text and the Todo mutation in one local editor (%s)',
    (order) => {
      const editor = createEditor()
      editor.update(
        () => {
          const list = $createListNode('check')
          const item = $createListItemNode(false)
          $setChecklistTodoId(item, 'todo-exclusive-owner')
          item.append($createTextNode('Draft'))
          list.append(item)
          $getRoot().append(list)
        },
        { discrete: true },
      )

      const typeLocally = () => {
        const text = $getChecklistItems()[0].getFirstChild()
        if (!$isTextNode(text)) {
          throw new Error('Expected checklist text')
        }
        text.setTextContent('Draft with pending typing')
      }
      const toggleFromTodos = () =>
        $applyChecklistEditorMutation(
          { todoId: 'todo-exclusive-owner', locator: '0.0', text: 'Draft with pending typing', checked: false },
          { checked: true },
        )

      editor.update(
        () => {
          if (order === 'typing-first') {
            typeLocally()
            expect(toggleFromTodos().matched).toBe(true)
          } else {
            expect(
              $applyChecklistEditorMutation(
                { todoId: 'todo-exclusive-owner', locator: '0.0', text: 'Draft', checked: false },
                { checked: true },
              ).matched,
            ).toBe(true)
            typeLocally()
          }
        },
        { discrete: true },
      )

      const serialized = JSON.stringify(editor.getEditorState())
      expect(serialized).toContain('Draft with pending typing')
      editor.read(() => expect($getChecklistItems()[0].getChecked()).toBe(true))
    },
  )
})
