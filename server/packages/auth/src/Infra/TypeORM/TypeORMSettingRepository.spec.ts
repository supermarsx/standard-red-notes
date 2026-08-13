import { SettingName } from '@standardnotes/domain-core'

import { TypeORMSettingRepository } from './TypeORMSettingRepository'

describe('TypeORMSettingRepository email backup reconciliation scans', () => {
  const createQueryBuilder = () => {
    const builder = {
      where: jest.fn(),
      orderBy: jest.fn(),
      take: jest.fn(),
      skip: jest.fn(),
      getCount: jest.fn().mockResolvedValue(2),
      getMany: jest.fn().mockResolvedValue([{ uuid: 'one' }, { uuid: 'two' }]),
    }
    for (const method of ['where', 'orderBy', 'take', 'skip'] as const) {
      builder[method].mockReturnValue(builder)
    }

    return builder
  }

  it('counts all delivery-state rows regardless of encrypted value', async () => {
    const builder = createQueryBuilder()
    const repository = new TypeORMSettingRepository(
      { createQueryBuilder: jest.fn().mockReturnValue(builder) } as never,
      {} as never,
    )

    await expect(
      repository.countAllByName(SettingName.create(SettingName.NAMES.EmailBackupDeliveryState).getValue()),
    ).resolves.toBe(2)
    expect(builder.where).toHaveBeenCalledWith('name = :name', { name: 'EMAIL_BACKUP_DELIVERY_STATE' })
  })

  it('pages all delivery-state rows deterministically and maps them to domain settings', async () => {
    const builder = createQueryBuilder()
    const mapper = { toDomain: jest.fn((value) => ({ mapped: value.uuid })) }
    const repository = new TypeORMSettingRepository(
      { createQueryBuilder: jest.fn().mockReturnValue(builder) } as never,
      mapper as never,
    )

    await expect(
      repository.findAllByName({
        name: SettingName.create(SettingName.NAMES.EmailBackupDeliveryState).getValue(),
        offset: 100,
        limit: 50,
      }),
    ).resolves.toEqual([{ mapped: 'one' }, { mapped: 'two' }])
    expect(builder.orderBy).toHaveBeenCalledWith('created_at', 'ASC')
    expect(builder.take).toHaveBeenCalledWith(50)
    expect(builder.skip).toHaveBeenCalledWith(100)
  })
})
