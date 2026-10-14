import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { TypeORMCacheEntry } from './TypeORMCacheEntry'
import { TypeORMCacheEntryRepository } from './TypeORMCacheEntryRepository'

describe('atomic verified grant consume in SQL', () => {
  let source: DataSource
  let repository: TypeORMCacheEntryRepository
  beforeEach(async () => {
    source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [TypeORMCacheEntry], synchronize: true }).initialize()
    repository = new TypeORMCacheEntryRepository(source.getRepository(TypeORMCacheEntry), {} as never)
  })
  afterEach(async () => { await source.destroy() })
  it('only one concurrent caller consumes all duplicate live grant rows', async () => {
    await source.getRepository(TypeORMCacheEntry).save([
      { key: 'verified-grant', value: 'verified', expiresAt: new Date(Date.now() + 60000) },
      { key: 'verified-grant', value: 'verified', expiresAt: new Date(Date.now() + 60000) },
    ])
    const results = await Promise.all([repository.consumeUnexpiredByKey('verified-grant'), repository.consumeUnexpiredByKey('verified-grant')])
    expect(results.sort()).toEqual([false, true])
    expect(await source.getRepository(TypeORMCacheEntry).count()).toBe(0)
  })
  it('cannot consume expired/missing grants and does not delete another account grant', async () => {
    await source.getRepository(TypeORMCacheEntry).save([
      { key: 'expired', value: 'verified', expiresAt: new Date(Date.now() - 60000) },
      { key: 'another-account', value: 'verified', expiresAt: new Date(Date.now() + 60000) },
    ])
    expect(await repository.consumeUnexpiredByKey('expired')).toBe(false)
    expect(await repository.consumeUnexpiredByKey('missing')).toBe(false)
    expect(await repository.consumeUnexpiredByKey('another-account')).toBe(true)
  })
})
