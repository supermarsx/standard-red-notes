import { AssistantWebAccessPolicy, normalizeAssistantWebAccessMode } from './assistantWebAccessPolicy'

it('defaults to Allow but treats malformed stored modes as Strict', () => {
  expect(normalizeAssistantWebAccessMode(undefined)).toBe('allow')
  expect(normalizeAssistantWebAccessMode('safe')).toBe('safe')
  expect(normalizeAssistantWebAccessMode('unexpected')).toBe('strict')
})
it('Safe grants only exact returned URLs from its approved searches', () => {
  const policy = new AssistantWebAccessPolicy()
  policy.recordSearch('allow', ['https://example.com/unapproved'])
  policy.recordSearch('safe', ['https://example.com/result', 'file:///private'])
  expect(policy.requiresApproval('safe', 'fetch', 'https://example.com/result')).toBe(false)
  expect(policy.requiresApproval('safe', 'fetch', 'https://example.com/result?other')).toBe(true)
  expect(policy.requiresApproval('safe', 'fetch', 'https://example.com/unapproved')).toBe(true)
  expect(policy.requiresApproval('safe', 'fetch', 'file:///private')).toBe(true)
  expect(policy.requiresApproval('strict', 'fetch', 'https://example.com/result')).toBe(true)
  expect(policy.requiresApproval('safe', 'search', 'topic')).toBe(true)
  expect(policy.requiresApproval('allow', 'search', 'topic')).toBe(false)
  expect(new AssistantWebAccessPolicy().requiresApproval('safe', 'fetch', 'https://example.com/result')).toBe(true)
})
