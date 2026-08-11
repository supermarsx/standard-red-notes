import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot, $isTextNode } from 'lexical'
import {
  $getChecklistDueAt,
  $getChecklistTodoId,
  $normalizeChecklistItemMetadata,
  $setChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'
import { $applyChecklistEditorMutation, $getChecklistItems } from './ChecklistEditorMutations'

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
