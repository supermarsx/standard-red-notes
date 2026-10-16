import { resolveSelfMentions, extractMentionedUuids } from './mentions'
it('resolves self references only outside existing mention tokens and standalone aliases', () => {
  const text = '@self, ask @SELF. Keep someone@self.test and @[literal @self](other) unchanged.'
  const resolved = resolveSelfMentions(text, 'own-account')
  expect(resolved).toBe(
    '@[self](own-account), ask @[self](own-account). Keep someone@self.test and @[literal @self](other) unchanged.',
  )
  expect(extractMentionedUuids(resolved)).toEqual(['own-account', 'other'])
  expect(resolveSelfMentions('@self', undefined)).toBe('@self')
})
