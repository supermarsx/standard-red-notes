import { AccountStorageUsageService } from './AccountStorageUsageService'
import { storageUsageSignature } from '@standardnotes/domain-core'
const user = '00000000-0000-4000-8000-000000000001',
  vault = '00000000-0000-4000-8000-000000000002'
describe('complete account storage composition', () => {
  afterEach(() => jest.restoreAllMocks())
  it('authenticates bounded authority requests and measures their actual successful responses', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ bytes: 7, count: 2, complete: true }), { status: 200 }),
      )
    const service = new AccountStorageUsageService(
      { measureStoredItems: async () => ({ bytes: 3, count: 1, complete: true }) } as never,
      { findByUserUuid: async () => [{ id: vault }, { id: vault }] } as never,
      'secret',
      'https://files.test/',
      'https://revisions.test/',
    )
    expect(await service.measure(user)).toMatchObject({ totalBytesUsed: 17, complete: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/(files|revisions)\.test\/internal\/storage-usage$/)
      const scope = JSON.parse(options!.body as string)
      expect(scope).toEqual({ userUuid: user, vaultUuids: [vault] })
      const headers = options!.headers as Record<string, string>
      expect(headers['x-storage-signature']).toBe(
        storageUsageSignature('secret', headers['x-storage-timestamp'], scope),
      )
      expect(options!.redirect).toBe('error')
    }
  })
  it('does not manufacture zero when authority configuration, status, or body is invalid', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bytes: -1, count: 0, complete: true }), { status: 200 }))
    const items = { measureStoredItems: async () => ({ bytes: 3, count: 1, complete: true }) }
    const vaults = { findByUserUuid: async () => [] }
    const unavailable = new AccountStorageUsageService(items as never, vaults as never, '', '', '')
    expect(await unavailable.measure(user)).toMatchObject({ complete: false, totalBytesUsed: null })
    expect(fetcher).not.toHaveBeenCalled()
    const invalid = new AccountStorageUsageService(
      items as never,
      vaults as never,
      'secret',
      'https://files.test',
      'https://revisions.test',
    )
    expect(await invalid.measure(user)).toMatchObject({
      complete: false,
      totalBytesUsed: null,
      components: { items: { bytes: 3 }, files: { bytes: null }, revisions: { bytes: null } },
    })
  })
  it('rejects invalid or oversized ownership scopes before reading authorities', async () => {
    const items = { measureStoredItems: jest.fn() }
    const vaults = {
      findByUserUuid: jest
        .fn()
        .mockResolvedValue(Array.from({ length: 1001 }, (_, index) => ({ id: `vault-${index}` }))),
    }
    const service = new AccountStorageUsageService(items as never, vaults as never, '', '', '')
    await expect(service.measure('invalid')).rejects.toThrow('Invalid account')
    expect(vaults.findByUserUuid).not.toHaveBeenCalled()
    await expect(service.measure(user)).rejects.toThrow('scope exceeds')
    expect(items.measureStoredItems).not.toHaveBeenCalled()
  })
  it('uses authoritativeownedvault scope once and totals all successful components', async () => {
    const items = { measureStoredItems: jest.fn().mockResolvedValue({ bytes: 10, count: 2, complete: true }) }
    const files = jest.fn().mockResolvedValue({ bytes: 30, count: 1, complete: true })
    const revisions = jest.fn().mockResolvedValue({ bytes: 20, count: 4, complete: true })
    const service = new AccountStorageUsageService(
      items as never,
      { findByUserUuid: async () => [{ id: vault }, { id: vault }] } as never,
      '',
      '',
      '',
    )
    service.setReaders(files, revisions)
    expect(await service.measure(user)).toMatchObject({
      totalBytesUsed: 60,
      complete: true,
      components: { items: { count: 2 }, files: { count: 1 }, revisions: { count: 4 } },
    })
    expect(files).toHaveBeenCalledWith({ userUuid: user, vaultUuids: [vault] })
    expect(items.measureStoredItems).toHaveBeenCalledWith(user, [vault])
  })
  it('retains available components but never publishes a complete zero/total when an authority fails or returns bad sizes', async () => {
    const service = new AccountStorageUsageService(
      { measureStoredItems: async () => ({ bytes: 10, count: 1, complete: true }) } as never,
      { findByUserUuid: async () => [] } as never,
      '',
      '',
      '',
    )
    service.setReaders(
      async () => {
        throw new Error('storage unavailable')
      },
      async () => ({ bytes: -1, count: 0, complete: true }),
    )
    expect(await service.measure(user)).toMatchObject({
      totalBytesUsed: null,
      complete: false,
      components: {
        items: { bytes: 10, complete: true },
        files: { bytes: null, complete: false },
        revisions: { bytes: null, complete: false },
      },
    })
  })
})
