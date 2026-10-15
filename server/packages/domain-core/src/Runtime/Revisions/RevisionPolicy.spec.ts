import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  effectiveRevisionPolicy,
  REVISION_POLICY_DEFAULTS,
  revisionPolicyBaseline,
  RevisionPolicyResolver,
  validRevisionPolicy,
} from './RevisionPolicy'

const user = '00000000-0000-4000-8000-000000000001'
describe('revision policy', () => {
  it('defaults to the last 200 revisions within 900 days', () => {
    expect(revisionPolicyBaseline(() => undefined)).toMatchObject({
      maxCountPerItem: 200,
      retentionDays: 900,
      debounceSeconds: 30,
    })
    expect(
      revisionPolicyBaseline((name) => (name === 'REVISIONS_RETENTION_DAYS' ? '0' : undefined)).retentionDays,
    ).toBe(0)
    expect(() => revisionPolicyBaseline(() => '-1')).toThrow('Invalid REVISIONS_RETENTION_DAYS')
  })
  it.each([NaN, Infinity, -1, 1.5, '200', Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %p', (value) => {
    expect(validRevisionPolicy({ maxCountPerItem: value })).toBe(false)
  })
  it('validates closed settings and UUID-scoped patches without allowing prototype keys', () => {
    expect(validRevisionPolicy({ maxCountPerItem: 200, users: { [user]: { maxCount: 300, maxBytes: 1024 } } })).toBe(
      true,
    )
    expect(validRevisionPolicy({ users: { [user]: null } }, true)).toBe(true)
    expect(validRevisionPolicy({ users: { [user]: { maxBytes: null } } }, true)).toBe(true)
    expect(validRevisionPolicy({ users: { [user]: null } })).toBe(false)
    expect(validRevisionPolicy({ users: { __proto__: 1, bad: {} } })).toBe(false)
    expect(validRevisionPolicy({ random: 3 })).toBe(false)
    expect(validRevisionPolicy({ users: { [user]: { maxCountTotal: 2 } } })).toBe(false)
  })
  it('allows tighter user limits while preserving absolute server caps', () => {
    const settings = {
      maxBytesPerUser: 1024,
      maxCountTotal: 9000,
      users: { [user]: { retentionDays: 10, maxCountPerItem: 20, maxBytes: 2048, maxCount: 50 } },
    }
    expect(effectiveRevisionPolicy(settings, REVISION_POLICY_DEFAULTS, user)).toMatchObject({
      retentionDays: 10,
      maxCountPerItem: 20,
      maxBytesPerUser: 1024,
      maxCountPerUser: 50,
      maxCountTotal: 9000,
    })
    expect(
      effectiveRevisionPolicy(
        { users: { [user]: { retentionDays: 0, maxCountPerItem: 900 } } },
        REVISION_POLICY_DEFAULTS,
        user,
      ),
    ).toMatchObject({ retentionDays: 900, maxCountPerItem: 200 })
  })
  it('reads changes live and refuses corrupt policy rather than silently dropping caps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'revision-policy-'))
    const path = join(dir, 'settings.json')
    try {
      const resolver = new RevisionPolicyResolver(path)
      expect((await resolver.resolve()).maxCountPerItem).toBe(200)
      await writeFile(path, JSON.stringify({ revisions: { maxCountPerItem: 50 } }))
      expect((await resolver.resolve()).maxCountPerItem).toBe(50)
      await writeFile(path, '{broken')
      await expect(resolver.resolve()).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
