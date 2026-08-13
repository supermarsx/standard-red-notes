import { createEmailDeliveryId } from './EmailDeliveryId'

describe('createEmailDeliveryId', () => {
  it('creates a stable Redis-safe digest without exposing source values', () => {
    const first = createEmailDeliveryId('reminder', 'private-user', 42)
    const retry = createEmailDeliveryId('reminder', 'private-user', 42)

    expect(first).toBe(retry)
    expect(first).toMatch(/^reminder-[0-9a-f]{64}$/)
    expect(first).not.toContain('private-user')
    expect(createEmailDeliveryId('reminder', 'private-user', 43)).not.toBe(first)
  })

  it.each([
    ['', ['value']],
    ['UPPERCASE', ['value']],
    ['scope with spaces', ['value']],
    ['a'.repeat(33), ['value']],
    ['valid', []],
    ['valid', ['']],
  ])('rejects invalid scope/parts %#', (scope, parts) => {
    expect(() => createEmailDeliveryId(scope, ...parts)).toThrow('Email delivery id inputs are invalid.')
  })

  it.each([Number.NaN, 1.5, null as never])('rejects invalid stable part %p', (part) => {
    expect(() => createEmailDeliveryId('valid', part)).toThrow('Email delivery id inputs are invalid.')
  })
})
