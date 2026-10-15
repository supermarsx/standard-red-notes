/** @jest-environment jsdom */
import { $createTextNode, $getRoot, createEditor } from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  $getChecklistPersonalTicks,
  $hasChecklistPersonalTick,
  $setChecklistPersonalTick,
  $setChecklistPerPerson,
  $isChecklistPerPerson,
  $getChecklistCheckedForUser,
} from './checklistPersonalTicks'
import { $applyChecklistItemChecked } from './ChecklistEditorMutations'
import { $setChecklistTodoId } from '../Lexical/Nodes/ChecklistItemNode'

function peer() {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  const element = document.createElement('div')
  document.body.append(element)
  editor.setRootElement(element)
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const provider = { awareness } as unknown as Provider
  const binding = createBinding(editor, provider, 'ticks', doc, new Map([['ticks', doc]]))
  const stop = editor.registerUpdateListener(
    ({ editorState, prevEditorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        provider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      )
    },
  )
  const receive = (events: Parameters<typeof syncYjsChangesToLexical>[2], transaction: Y.Transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events, false)
  }
  binding.root.getSharedType().observeDeep(receive)
  return {
    editor,
    doc,
    close() {
      stop()
      binding.root.getSharedType().unobserveDeep(receive)
      awareness.destroy()
      doc.destroy()
      editor.setRootElement(null)
      element.remove()
    },
  }
}
const item = () => ($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

it('merges concurrent ticks from two real Lexical/Yjs peers, and unticking only removes your own mark', async () => {
  const alice = peer()
  const bob = peer()
  try {
    alice.editor.update(
      () => {
        const task = $createListItemNode(false).append($createTextNode('Review release'))
        $setChecklistTodoId(task, 'todo-shared-release')
        $setChecklistPerPerson(task, true)
        $getRoot().append($createListNode('check').append(task))
      },
      { discrete: true },
    )
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc))
    await settle()
    alice.editor.update(() => $setChecklistPersonalTick(item(), 'alice', true), { discrete: true })
    bob.editor.update(() => $setChecklistPersonalTick(item(), 'bob', true), { discrete: true })
    const aliceUpdate = Y.encodeStateAsUpdate(alice.doc)
    const bobUpdate = Y.encodeStateAsUpdate(bob.doc)
    Y.applyUpdate(alice.doc, bobUpdate)
    Y.applyUpdate(bob.doc, aliceUpdate)
    await settle()
    for (const participant of [alice, bob]) {
      participant.editor.getEditorState().read(() => {
        expect($getChecklistPersonalTicks(item())).toEqual(['alice', 'bob'])
        expect($isChecklistPerPerson(item())).toBe(true)
        expect($getChecklistCheckedForUser(item(), 'alice')).toBe(true)
        expect($getChecklistCheckedForUser(item(), 'charlie')).toBe(false)
        expect(item().getChecked()).toBe(false)
      })
    }
    alice.editor.update(() => $setChecklistPersonalTick(item(), 'alice', false), { discrete: true })
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc))
    await settle()
    bob.editor.getEditorState().read(() => {
      expect($getChecklistPersonalTicks(item())).toEqual(['bob'])
      expect($hasChecklistPersonalTick(item(), 'bob')).toBe(true)
      expect($hasChecklistPersonalTick(item(), 'alice')).toBe(false)
    })
    const restored = createEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error
      },
    })
    restored.setEditorState(restored.parseEditorState(JSON.stringify(bob.editor.getEditorState().toJSON())))
    restored.getEditorState().read(() => {
      expect($getChecklistPersonalTicks(item())).toEqual(['bob'])
      expect($isChecklistPerPerson(item())).toBe(true)
    })
  } finally {
    alice.close()
    bob.close()
  }
})

it('defaults to single tick, preserves personal marks across mode changes, and refuses an invalid account key', () => {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const task = $createListItemNode(false)
      $getRoot().append($createListNode('check').append(task))
      expect($isChecklistPerPerson(task)).toBe(false)
      $setChecklistPerPerson(task, true)
      expect($applyChecklistItemChecked(task, true)).toEqual({ changed: false, advanced: false })
      $setChecklistPersonalTick(task, 'alice', true)
      $setChecklistPerPerson(task, false)
      expect($getChecklistCheckedForUser(task, 'alice')).toBe(false)
      $setChecklistPerPerson(task, true)
      expect($getChecklistCheckedForUser(task, 'alice')).toBe(true)
      $setChecklistPersonalTick(task, 'alice', false)
      expect(() => $setChecklistPersonalTick(task, '<not-an-account>', true)).toThrow('signed-in account')
      expect($getChecklistPersonalTicks(task)).toEqual([])
    },
    { discrete: true },
  )
})
