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
import {
  $getChecklistDueAt,
  $getChecklistTodoId,
  $isChecklistItemNode,
  $normalizeChecklistItemMetadata,
  $setChecklistDueAt,
  $setChecklistTodoId,
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_TODO_ID_STATE_KEY,
  createChecklistTodoId,
} from './ChecklistItemNode'

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
        [CHECKLIST_DUE_AT_STATE_KEY]: '2026-08-12T12:30:00.000Z',
      },
    })

    const reloaded = createEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(first)))
    reloaded.read(() => {
      const list = $getRoot().getFirstChild()
      const item = $isListNode(list) ? list.getFirstChild() : null
      expect($isListItemNode(item)).toBe(true)
      expect($isChecklistItemNode(item)).toBe(true)
      expect($getChecklistTodoId(item as ListItemNode)).toBe('todo-stable-123')
      expect($getChecklistDueAt(item as ListItemNode)).toBe('2026-08-12T12:30:00.000Z')
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

  it('resets identity and deadline when a checklist row is copied', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const list = $createListNode('check')
        const item = $createListItemNode(false)
        $setChecklistTodoId(item, 'todo-original')
        $setChecklistDueAt(item, '2026-08-12T12:00:00.000Z')
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
      },
      { discrete: true },
    )
  })
})
