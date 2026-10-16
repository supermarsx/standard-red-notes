import { assistantDirectiveContextMatches } from './assistantDirectiveContext'
import type { AssistantChatDirective } from './assistantDirectives'
const directive = {
  noteUuid: 'note-a',
  selectedText: 'exact excerpt',
  contextKind: 'selection',
} as AssistantChatDirective
it('reuses only a known single-note context with the exact excerpt or the complete note', () => {
  expect(assistantDirectiveContextMatches({ noteUuids: ['note-a'], selectedText: 'exact excerpt' }, directive)).toBe(
    true,
  )
  expect(
    assistantDirectiveContextMatches({ noteUuids: ['note-a'], selectedText: 'different excerpt' }, directive),
  ).toBe(false)
  expect(assistantDirectiveContextMatches({ noteUuids: ['note-a'] }, directive)).toBe(false)
  expect(assistantDirectiveContextMatches({ noteUuids: ['note-b'], selectedText: 'exact excerpt' }, directive)).toBe(
    false,
  )
  expect(
    assistantDirectiveContextMatches({ noteUuids: ['note-a', 'note-b'] }, { ...directive, contextKind: 'note' }),
  ).toBe(false)
  expect(assistantDirectiveContextMatches({ noteUuids: ['note-a'] }, { ...directive, contextKind: 'note' })).toBe(true)
  expect(assistantDirectiveContextMatches(undefined, directive)).toBe(false)
})
