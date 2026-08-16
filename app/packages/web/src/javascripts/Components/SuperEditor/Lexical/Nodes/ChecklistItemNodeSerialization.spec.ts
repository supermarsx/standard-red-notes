import {
  $createListNode,
  $createListItemNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot } from 'lexical'
import * as Y from 'yjs'
import {
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $getChecklistSchedule,
  $getChecklistTodoId,
  $isChecklistItemNode,
  $normalizeChecklistItemMetadata,
  $setChecklistDueAt,
  $setChecklistRecurrence,
  $setChecklistTodoId,
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_RECURRENCE_STATE_KEY,
  CHECKLIST_SCHEDULE_STATE_KEY,
  CHECKLIST_SCHEDULE_VERSION,
  CHECKLIST_TODO_ID_STATE_KEY,
  createChecklistTodoId,
} from './ChecklistItemNode'
import { createChecklistRecurrence } from '../../Checklist/checklistRecurrence'

const createEditor = () =>
  createHeadlessEditor({
    namespace: 'checklist-item-state-test',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

describe('checklist ListItemNode state serialization', () => {
  it('uses secure random bytes rather than time/counters when randomUUID is unavailable', () => {
    let seed = 0
    const secureBytesOnly = {
      getRandomValues: (bytes: Uint8Array) => {
        seed += 1
        bytes.fill(seed)
        return bytes
      },
    } as unknown as Crypto
    const first = createChecklistTodoId(secureBytesOnly)
    const second = createChecklistTodoId(secureBytesOnly)
    expect(first).toMatch(/^todo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
    expect(() => createChecklistTodoId({} as Crypto)).toThrow('Secure random values')
  })

  it('round-trips stable identity, UTC due time and checked state without changing the node type', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistTodoId(item, 'todo-stable-123')
        $setChecklistDueAt(item, '2026-08-12T13:30:00+01:00')
        $setChecklistRecurrence(item, createChecklistRecurrence('monthly', '2026-08-12T12:30:00.000Z', 'Europe/London'))
        item.append($createTextNode('Ship release'))
        list.append(item)
        $getRoot().append(list)
      },
      { discrete: true },
    )

    const first = editor.getEditorState().toJSON()
    const serializedList = first.root.children[0] as unknown as { children?: unknown[] }
    const serializedItem = serializedList.children?.[0] as Record<string, unknown>
    expect(serializedItem).toMatchObject({
      type: 'listitem',
      checked: false,
      $: {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-stable-123',
        [CHECKLIST_SCHEDULE_STATE_KEY]: {
          version: CHECKLIST_SCHEDULE_VERSION,
          dueAt: '2026-08-12T12:30:00.000Z',
          recurrence: expect.objectContaining({
            frequency: 'monthly',
            anchor: expect.objectContaining({ timeZone: 'Europe/London', day: 12, hour: 13 }),
          }),
        },
      },
    })
    expect((serializedItem.$ as Record<string, unknown>)[CHECKLIST_DUE_AT_STATE_KEY]).toBeUndefined()
    expect((serializedItem.$ as Record<string, unknown>)[CHECKLIST_RECURRENCE_STATE_KEY]).toBeUndefined()

    const reloaded = createEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(first)))
    reloaded.read(() => {
      const list = $getRoot().getFirstChild()
      const item = $isListNode(list) ? list.getFirstChild() : null
      expect($isListItemNode(item)).toBe(true)
      expect($isChecklistItemNode(item)).toBe(true)
      expect($getChecklistTodoId(item as ListItemNode)).toBe('todo-stable-123')
      expect($getChecklistDueAt(item as ListItemNode)).toBe('2026-08-12T12:30:00.000Z')
      expect($getChecklistRecurrence(item as ListItemNode)).toMatchObject({
        frequency: 'monthly',
        anchor: { timeZone: 'Europe/London', day: 12, hour: 13 },
      })
    })
  })

  it('adds an identity to old listitem JSON without changing its type or content', () => {
    const editor = createEditor()
    const old = JSON.stringify({
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
    })
    editor.setEditorState(editor.parseEditorState(old))
    editor.update(
      () => {
        expect($normalizeChecklistItemMetadata()).toBe(1)
      },
      { discrete: true },
    )
    editor.read(() => {
      const list = $getRoot().getFirstChild()
      const item = $isListNode(list) ? list.getFirstChild() : null
      expect($isChecklistItemNode(item)).toBe(true)
      expect($getChecklistTodoId(item as ListItemNode)).toMatch(/^todo-/)
      expect(item?.getTextContent()).toBe('Legacy')
      expect(item?.getType()).toBe('listitem')
    })
  })

  it('migrates split schedules, drops orphan rules, and gives a present envelope fail-closed precedence', () => {
    const legacyRule = createChecklistRecurrence('weekly', '2026-08-12T12:00:00.000Z', 'UTC')
    const atomicRule = createChecklistRecurrence('monthly', '2026-09-15T12:00:00.000Z', 'UTC')
    const states: Array<Record<string, unknown>> = [
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-legacy-due',
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:00:00.000Z',
      },
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-legacy-pair',
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:00:00.000Z',
        [CHECKLIST_RECURRENCE_STATE_KEY]: legacyRule,
      },
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-orphan-rule',
        [CHECKLIST_RECURRENCE_STATE_KEY]: legacyRule,
      },
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-malformed-rule',
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:00:00.000Z',
        [CHECKLIST_RECURRENCE_STATE_KEY]: { frequency: 'hourly' },
      },
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-atomic-wins',
        [CHECKLIST_SCHEDULE_STATE_KEY]: {
          version: CHECKLIST_SCHEDULE_VERSION,
          dueAt: '2026-09-15T12:00:00.000Z',
          recurrence: atomicRule,
        },
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:00:00.000Z',
        [CHECKLIST_RECURRENCE_STATE_KEY]: legacyRule,
      },
      {
        [CHECKLIST_TODO_ID_STATE_KEY]: 'todo-future-envelope',
        [CHECKLIST_SCHEDULE_STATE_KEY]: {
          version: 99,
          dueAt: '2030-01-01T00:00:00.000Z',
          futureRule: { cadence: 'lunar' },
        },
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:00:00.000Z',
        [CHECKLIST_RECURRENCE_STATE_KEY]: legacyRule,
      },
    ]
    const editor = createEditor()
    const serialized = JSON.stringify({
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
            children: states.map((state, index) => ({
              type: 'listitem',
              version: 1,
              value: index + 1,
              checked: false,
              format: '',
              indent: 0,
              direction: null,
              $: state,
              children: [
                { type: 'text', version: 1, text: `Task ${index}`, format: 0, detail: 0, mode: 'normal', style: '' },
              ],
            })),
          },
        ],
      },
    })
    editor.setEditorState(editor.parseEditorState(serialized))
    editor.read(() => {
      const list = $getRoot().getFirstChild()
      if (!$isListNode(list)) {
        throw new Error('Expected checklist')
      }
      const items = list.getChildren() as ListItemNode[]
      expect($getChecklistSchedule(items[0])).toMatchObject({ dueAt: '2026-08-12T12:00:00.000Z' })
      expect($getChecklistSchedule(items[1])).toMatchObject({ recurrence: { frequency: 'weekly' } })
      expect($getChecklistSchedule(items[2])).toBeUndefined()
      expect($getChecklistSchedule(items[3])).toEqual({
        version: CHECKLIST_SCHEDULE_VERSION,
        dueAt: '2026-08-12T12:00:00.000Z',
      })
      expect($getChecklistSchedule(items[4])).toMatchObject({
        dueAt: '2026-09-15T12:00:00.000Z',
        recurrence: { frequency: 'monthly' },
      })
      expect($getChecklistSchedule(items[5])).toBeUndefined()
    })

    editor.update(
      () => {
        expect($normalizeChecklistItemMetadata()).toBeGreaterThanOrEqual(5)
      },
      { discrete: true },
    )
    const migrated = editor.getEditorState().toJSON()
    const list = migrated.root.children[0] as unknown as { children: Array<{ $?: Record<string, unknown> }> }
    const migratedStates = list.children.map((item) => item.$ ?? {})
    expect(migratedStates[0][CHECKLIST_SCHEDULE_STATE_KEY]).toEqual({
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-12T12:00:00.000Z',
    })
    expect(migratedStates[1][CHECKLIST_SCHEDULE_STATE_KEY]).toMatchObject({
      dueAt: '2026-08-12T12:00:00.000Z',
      recurrence: { frequency: 'weekly' },
    })
    expect(migratedStates[2][CHECKLIST_SCHEDULE_STATE_KEY]).toBeUndefined()
    expect(migratedStates[3][CHECKLIST_SCHEDULE_STATE_KEY]).toEqual({
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-12T12:00:00.000Z',
    })
    expect(migratedStates[4][CHECKLIST_SCHEDULE_STATE_KEY]).toMatchObject({
      dueAt: '2026-09-15T12:00:00.000Z',
      recurrence: { frequency: 'monthly' },
    })
    expect(migratedStates[5][CHECKLIST_SCHEDULE_STATE_KEY]).toEqual({
      version: 99,
      dueAt: '2030-01-01T00:00:00.000Z',
      futureRule: { cadence: 'lunar' },
    })
    for (const state of migratedStates) {
      expect(state[CHECKLIST_DUE_AT_STATE_KEY]).toBeUndefined()
      expect(state[CHECKLIST_RECURRENCE_STATE_KEY]).toBeUndefined()
    }
  })

  it('converges concurrent schedule-edit and recurrence-completion writes as one authored pair', () => {
    const scheduleAttribute = `s_${CHECKLIST_SCHEDULE_STATE_KEY}`
    const initial = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-16T09:00:00.000Z',
      recurrence: createChecklistRecurrence('daily', '2026-08-16T09:00:00.000Z', 'UTC'),
    }
    const edited = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-09-30T09:00:00.000Z',
      recurrence: createChecklistRecurrence('monthly', '2026-09-30T09:00:00.000Z', 'UTC'),
    }
    const completed = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-17T09:00:00.000Z',
      recurrence: initial.recurrence,
    }
    const seed = new Y.Doc()
    const seedItem = new Y.XmlElement('listitem')
    seed.getXmlFragment('root').insert(0, [seedItem])
    seedItem.setAttribute(scheduleAttribute, initial as unknown as string)
    const initialUpdate = Y.encodeStateAsUpdate(seed)
    const first = new Y.Doc()
    const second = new Y.Doc()
    Y.applyUpdate(first, initialUpdate)
    Y.applyUpdate(second, initialUpdate)
    const firstItem = first.getXmlFragment('root').get(0) as Y.XmlElement
    const secondItem = second.getXmlFragment('root').get(0) as Y.XmlElement
    firstItem.setAttribute(scheduleAttribute, edited as unknown as string)
    secondItem.setAttribute(scheduleAttribute, completed as unknown as string)

    const firstUpdate = Y.encodeStateAsUpdate(first)
    const secondUpdate = Y.encodeStateAsUpdate(second)
    Y.applyUpdate(first, secondUpdate)
    Y.applyUpdate(second, firstUpdate)
    const firstResult = firstItem.getAttribute(scheduleAttribute)
    const secondResult = secondItem.getAttribute(scheduleAttribute)
    expect(firstResult).toEqual(secondResult)
    expect([edited, completed]).toContainEqual(firstResult)

    const reverseOrder = new Y.Doc()
    Y.applyUpdate(reverseOrder, secondUpdate)
    Y.applyUpdate(reverseOrder, firstUpdate)
    expect((reverseOrder.getXmlFragment('root').get(0) as Y.XmlElement).getAttribute(scheduleAttribute)).toEqual(
      firstResult,
    )
  })

  it('converges a concurrent clear versus edit to either the whole envelope or no schedule', () => {
    const scheduleAttribute = `s_${CHECKLIST_SCHEDULE_STATE_KEY}`
    const initial = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-16T09:00:00.000Z',
      recurrence: createChecklistRecurrence('daily', '2026-08-16T09:00:00.000Z', 'UTC'),
    }
    const edited = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-10-16T09:00:00.000Z',
      recurrence: createChecklistRecurrence('yearly', '2026-10-16T09:00:00.000Z', 'UTC'),
    }
    const cleared = { version: CHECKLIST_SCHEDULE_VERSION, cleared: true }
    const seed = new Y.Doc()
    const seedItem = new Y.XmlElement('listitem')
    seed.getXmlFragment('root').insert(0, [seedItem])
    seedItem.setAttribute(scheduleAttribute, initial as unknown as string)
    const initialUpdate = Y.encodeStateAsUpdate(seed)
    const first = new Y.Doc()
    const second = new Y.Doc()
    Y.applyUpdate(first, initialUpdate)
    Y.applyUpdate(second, initialUpdate)
    ;(first.getXmlFragment('root').get(0) as Y.XmlElement).setAttribute(scheduleAttribute, edited as unknown as string)
    ;(second.getXmlFragment('root').get(0) as Y.XmlElement).setAttribute(
      scheduleAttribute,
      cleared as unknown as string,
    )
    const firstUpdate = Y.encodeStateAsUpdate(first)
    const secondUpdate = Y.encodeStateAsUpdate(second)

    const mergedFirst = new Y.Doc()
    Y.applyUpdate(mergedFirst, firstUpdate)
    Y.applyUpdate(mergedFirst, secondUpdate)
    const mergedSecond = new Y.Doc()
    Y.applyUpdate(mergedSecond, secondUpdate)
    Y.applyUpdate(mergedSecond, firstUpdate)
    const firstResult = (mergedFirst.getXmlFragment('root').get(0) as Y.XmlElement).getAttribute(scheduleAttribute)
    const secondResult = (mergedSecond.getXmlFragment('root').get(0) as Y.XmlElement).getAttribute(scheduleAttribute)
    expect(firstResult).toEqual(secondResult)
    expect([edited, cleared]).toContainEqual(firstResult)
  })

  it('makes an explicit clear compete atomically with concurrent legacy migration', () => {
    const scheduleAttribute = `s_${CHECKLIST_SCHEDULE_STATE_KEY}`
    const dueAttribute = `s_${CHECKLIST_DUE_AT_STATE_KEY}`
    const recurrenceAttribute = `s_${CHECKLIST_RECURRENCE_STATE_KEY}`
    const dueAt = '2026-08-16T09:00:00.000Z'
    const recurrence = createChecklistRecurrence('daily', dueAt, 'UTC')!
    const migrated = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt,
      recurrence,
    }
    const cleared = { version: CHECKLIST_SCHEDULE_VERSION, cleared: true }
    const seed = new Y.Doc()
    const seedItem = new Y.XmlElement('listitem')
    seed.getXmlFragment('root').insert(0, [seedItem])
    seedItem.setAttribute(dueAttribute, dueAt)
    seedItem.setAttribute(recurrenceAttribute, recurrence as unknown as string)
    const initialUpdate = Y.encodeStateAsUpdate(seed)
    const migratingClient = new Y.Doc()
    const clearingClient = new Y.Doc()
    Y.applyUpdate(migratingClient, initialUpdate)
    Y.applyUpdate(clearingClient, initialUpdate)

    const migrateItem = migratingClient.getXmlFragment('root').get(0) as Y.XmlElement
    const clearItem = clearingClient.getXmlFragment('root').get(0) as Y.XmlElement
    migrateItem.setAttribute(scheduleAttribute, migrated as unknown as string)
    migrateItem.removeAttribute(dueAttribute)
    migrateItem.removeAttribute(recurrenceAttribute)
    clearItem.setAttribute(scheduleAttribute, cleared as unknown as string)
    clearItem.removeAttribute(dueAttribute)
    clearItem.removeAttribute(recurrenceAttribute)
    const migrationUpdate = Y.encodeStateAsUpdate(migratingClient)
    const clearingUpdate = Y.encodeStateAsUpdate(clearingClient)

    const forward = new Y.Doc()
    Y.applyUpdate(forward, migrationUpdate)
    Y.applyUpdate(forward, clearingUpdate)
    const reverse = new Y.Doc()
    Y.applyUpdate(reverse, clearingUpdate)
    Y.applyUpdate(reverse, migrationUpdate)
    const forwardItem = forward.getXmlFragment('root').get(0) as Y.XmlElement
    const reverseItem = reverse.getXmlFragment('root').get(0) as Y.XmlElement
    expect(forwardItem.getAttribute(scheduleAttribute)).toEqual(reverseItem.getAttribute(scheduleAttribute))
    expect([migrated, cleared]).toContainEqual(forwardItem.getAttribute(scheduleAttribute))
    expect(forwardItem.getAttribute(dueAttribute)).toBeUndefined()
    expect(forwardItem.getAttribute(recurrenceAttribute)).toBeUndefined()
  })

  it('persists an explicit clear as a versioned atomic tombstone', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistDueAt(item, '2026-08-16T09:00:00.000Z')
        $setChecklistRecurrence(item, createChecklistRecurrence('daily', '2026-08-16T09:00:00.000Z', 'UTC'))
        $setChecklistDueAt(item, undefined)
        item.append($createTextNode('Cleared'))
        list.append(item)
        $getRoot().append(list)
        expect($getChecklistSchedule(item)).toBeUndefined()
      },
      { discrete: true },
    )
    const serialized = editor.getEditorState().toJSON()
    const list = serialized.root.children[0] as unknown as { children: Array<{ $?: Record<string, unknown> }> }
    expect(list.children[0].$?.[CHECKLIST_SCHEDULE_STATE_KEY]).toEqual({
      version: CHECKLIST_SCHEDULE_VERSION,
      cleared: true,
    })
    expect(list.children[0].$?.[CHECKLIST_DUE_AT_STATE_KEY]).toBeUndefined()
    expect(list.children[0].$?.[CHECKLIST_RECURRENCE_STATE_KEY]).toBeUndefined()
  })

  it('repairs a concurrently merged checked recurring row to its active occurrence', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const dueAt = '2026-08-16T09:00:00.000Z'
        const item = $createListItemNode(false).append($createTextNode('Merged recurrence'))
        $setChecklistTodoId(item, 'todo-merged-recurrence')
        $setChecklistDueAt(item, dueAt)
        $setChecklistRecurrence(item, createChecklistRecurrence('weekly', dueAt, 'UTC'))
        // This is the cross-field state produced when an ordinary completion
        // wins concurrently with another client adding recurrence.
        item.setChecked(true)
        $getRoot().append($createListNode('check').append(item))
        expect($normalizeChecklistItemMetadata()).toBe(1)
        expect(item.getChecked()).toBe(false)
        expect($getChecklistRecurrence(item)?.frequency).toBe('weekly')
      },
      { discrete: true },
    )
  })

  it('resets identity, deadline, and recurrence when a checklist row is copied', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistTodoId(item, 'todo-original')
        $setChecklistDueAt(item, '2026-08-12T12:00:00.000Z')
        $setChecklistRecurrence(item, createChecklistRecurrence('daily', '2026-08-12T12:00:00.000Z', 'UTC'))
        item.append($createTextNode('Original'))
        list.append(item)
        $getRoot().append(list)
        const copy = item.insertNewAfter({} as never)
        expect($isChecklistItemNode(copy)).toBe(true)
        if (!$isListItemNode(copy)) {
          throw new Error('Expected a copied list item')
        }
        expect($getChecklistTodoId(copy)).toBeUndefined()
        expect($getChecklistDueAt(copy)).toBeUndefined()
        expect($getChecklistRecurrence(copy)).toBeUndefined()
      },
      { discrete: true },
    )
  })
})
