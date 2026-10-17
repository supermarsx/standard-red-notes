import { normalizeAssistantChatComposerState as normalize } from './assistantChatComposerState'

it('normalizes a bounded draft and context without retaining provider fields', () => {
  expect(
    normalize({
      draft: { value: { text: 'hi', apiKey: 'secret' }, updatedAt: 1 },
      context: {
        value: { scope: 'selection', excerpt: { noteUuid: 'note', text: 'excerpt' }, token: 'secret' },
        updatedAt: 2,
      },
      provider: 'secret',
    }),
  ).toEqual({
    draft: { value: { text: 'hi', attachments: [] }, updatedAt: 1 },
    context: { value: { scope: 'selection', excerpt: { noteUuid: 'note', text: 'excerpt' } }, updatedAt: 2 },
  })
})
it('keeps empty and cleared drafts distinct from absent fields', () => {
  expect(normalize({})).toEqual({})
  expect(normalize({ draft: { value: null, updatedAt: 1 } })?.draft?.value).toBeNull()
  expect(normalize({ draft: { value: { text: '' }, updatedAt: 2 } })?.draft?.value?.text).toBe('')
})
it('rejects oversized drafts, invalid contexts, permissions and clocks', () => {
  expect(normalize({ draft: { value: { text: 'x'.repeat(32001) }, updatedAt: 1 } })).toBeUndefined()
  expect(normalize({ context: { value: { scope: 'collection', collection: null }, updatedAt: 1 } })).toBeUndefined()
  expect(
    normalize({
      context: { value: { scope: 'selection', excerpt: { noteUuid: 'note', text: 'x'.repeat(8001) } }, updatedAt: 1 },
    }),
  ).toBeUndefined()
  expect(normalize({ toolPermissionMode: { value: 'execute', updatedAt: 1 } })).toBeUndefined()
  expect(normalize({ draft: { value: null, updatedAt: Infinity } })).toBeUndefined()
})
