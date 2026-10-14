import { AccountStorageUsageService } from './AccountStorageUsageService'
const user = '00000000-0000-4000-8000-000000000001',
  vault = '00000000-0000-4000-8000-000000000002'
describe('complete account storage composition', () => {
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
