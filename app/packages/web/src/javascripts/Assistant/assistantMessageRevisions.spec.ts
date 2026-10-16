import { changedAssistantMessageIds } from './assistantMessageRevisions'
it('detects inserted, changed and deleted immutable messages without serializing historic payloads', () => {
  const history = {
    id: 'history',
    text: 'x'.repeat(250000),
    toJSON: () => {
      throw new Error('Historic attachment serialized')
    },
  }
  const oldActive = { id: 'active', text: 'before' }
  const removed = { id: 'removed', text: 'deleted' }
  const nextActive = { ...oldActive, text: 'before next delta' }
  expect(
    changedAssistantMessageIds([history, oldActive, removed], [history, nextActive, { id: 'added', text: 'new' }]),
  ).toEqual(new Set(['active', 'added', 'removed']))
  expect(changedAssistantMessageIds([history, nextActive], [history, nextActive])).toEqual(new Set())
})
it('conservatively retains immutable replacement edits even when their text is equal', () => {
  const previous = { id: 'message', text: 'same' }
  expect(changedAssistantMessageIds([previous], [{ ...previous }])).toEqual(new Set(['message']))
})
