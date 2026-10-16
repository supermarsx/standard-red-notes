import { acknowledgeAssistantSharedVersions, reconcileAssistantSharedMessages } from './assistantSharedHistory'
it('keeps a terminal local response through a delayed partial checkpoint while accepting unrelated remote changes', () => {
  const local = [
    { id: 'answer', text: 'Complete terminal answer', streaming: false },
    { id: 'other', text: 'old remote', streaming: false },
  ]
  const observed = [
    { id: 'answer', text: 'Partial', streaming: false },
    { id: 'other', text: 'new remote', streaming: false },
  ]
  expect(reconcileAssistantSharedMessages(observed, local, new Set(['answer']))).toEqual([local[0], observed[1]])
  expect(reconcileAssistantSharedMessages(observed, local, new Set())).toEqual(observed)
})
it('keeps newly dirty messages and does not resurrect locally removed IDs before acknowledgment', () => {
  expect(reconcileAssistantSharedMessages([{ id: 'removed' }], [{ id: 'new' }], new Set(['removed', 'new']))).toEqual([
    { id: 'new' },
  ])
})

it('applies an acknowledged remote removal immediately but preserves edits newer than that checkpoint', () => {
  const local = [{ id: 'answer', text: 'Terminal response' }]
  const dirty = new Map([['answer', 2]])
  acknowledgeAssistantSharedVersions(dirty, new Map([['answer', 1]]))
  expect(reconcileAssistantSharedMessages([], local, new Set(dirty.keys()))).toEqual(local)
  acknowledgeAssistantSharedVersions(dirty, new Map([['answer', 2]]))
  expect(reconcileAssistantSharedMessages([], local, new Set(dirty.keys()))).toEqual([])
})
