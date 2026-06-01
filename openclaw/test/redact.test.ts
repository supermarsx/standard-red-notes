import { describe, it, expect } from 'vitest'
import { redactForAudit, noteSummary } from '../src/util/redact.js'

describe('redactForAudit', () => {
  it('replaces note body content', () => {
    const out = redactForAudit({ title: 'shopping', body: 'eggs milk' }) as Record<string, unknown>
    expect(out.title).toBe('shopping')
    expect(out.body).toMatch(/^<note:/)
  })

  it('masks token-like strings', () => {
    const out = redactForAudit('sk-abc12345xyz_more')
    expect(out).toBe('<redacted-token>')
  })

  it('recurses into arrays', () => {
    const out = redactForAudit([{ body: 'secret' }, 'sk-abc12345xyz']) as Array<Record<string, unknown> | string>
    expect((out[0] as Record<string, unknown>).body).toMatch(/^<note:/)
    expect(out[1]).toBe('<redacted-token>')
  })
})

describe('noteSummary', () => {
  it('encodes length and uuid', () => {
    expect(noteSummary('hello', { uuid: 'u1' })).toBe('<note:u1 5 chars>')
  })
})
