import 'reflect-metadata'

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DomainEventInterface } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { DomainEventFactory } from '../../Event/DomainEventFactory'
import { FSFileDownloader } from '../../../Infra/FS/FSFileDownloader'
import { RecalculateQuota } from './RecalculateQuota'

/**
 * Standard Red Notes: the recount as the all-in-one container runs it -- the real
 * filesystem lister over a real directory, the real event factory -- because the
 * unit suite beside this one hands the use case a `listFiles` that always
 * resolves, and what failed was a `listFiles` that did not.
 *
 * An administrator's "Recalculate storage quota" for an account that had never
 * uploaded answered 500 there: no upload had ever created the account's
 * directory, `readdir` threw ENOENT, and nothing between it and the HTTP response
 * stopped it. The honest answer was always available: the account has no files.
 */
describe('RecalculateQuota over the real filesystem', () => {
  const userUuid = '00000000-0000-4000-8000-000000000001'
  const createdAt = new Date('2026-10-12T12:00:00.000Z')
  let uploadRoot: string
  let published: DomainEventInterface[]

  const recount = () =>
    new RecalculateQuota(
      new FSFileDownloader(uploadRoot),
      { publish: async (event: DomainEventInterface) => void published.push(event) },
      new DomainEventFactory({ getUTCDate: () => createdAt } as unknown as TimerInterface),
    ).execute({ userUuid })

  beforeEach(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'srn-recalculate-quota-'))
    published = []
  })

  afterEach(async () => {
    await rm(uploadRoot, { recursive: true, force: true })
  })

  it('answers a measured zero for an account that has never uploaded, instead of failing', async () => {
    // Another account's storage exists, so the root is there to look in.
    await mkdir(join(uploadRoot, '00000000-0000-4000-8000-000000000002'), { recursive: true })

    const result = await recount()

    expect(result.isFailed()).toBeFalsy()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      type: 'FILE_QUOTA_RECALCULATED',
      payload: { userUuid, totalFileByteSize: 0 },
    })
  })

  it('sums the bytes actually stored for the account, and only that account', async () => {
    await mkdir(join(uploadRoot, userUuid), { recursive: true })
    await writeFile(join(uploadRoot, userUuid, 'remote-1'), Buffer.alloc(300_017))
    await writeFile(join(uploadRoot, userUuid, 'remote-2'), Buffer.alloc(500_017))
    await mkdir(join(uploadRoot, '00000000-0000-4000-8000-000000000002'), { recursive: true })
    await writeFile(join(uploadRoot, '00000000-0000-4000-8000-000000000002', 'theirs'), Buffer.alloc(7))

    await recount()

    expect(published.map((event) => event.payload)).toEqual([{ userUuid, totalFileByteSize: 800_034 }])
  })

  it('publishes no figure at all when the storage root is gone, rather than a zero it did not measure', async () => {
    await rm(uploadRoot, { recursive: true, force: true })

    await expect(recount()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(published).toEqual([])
  })
})
