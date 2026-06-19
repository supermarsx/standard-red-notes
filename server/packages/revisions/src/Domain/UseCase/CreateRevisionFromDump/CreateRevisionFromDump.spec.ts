import { Uuid, ContentType, Dates, Result } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { DumpRepositoryInterface } from '../../Dump/DumpRepositoryInterface'
import { Revision } from '../../Revision/Revision'
import { RevisionRepositoryInterface } from '../../Revision/RevisionRepositoryInterface'
import { CreateRevisionFromDump } from './CreateRevisionFromDump'

describe('CreateRevisionFromDump', () => {
  let revisionRepository: RevisionRepositoryInterface
  let revision: Revision
  let dumpRepository: DumpRepositoryInterface
  let timer: TimerInterface
  let retentionDays: number
  let maxCountPerItem: number

  const createUseCase = () =>
    new CreateRevisionFromDump(dumpRepository, revisionRepository, timer, retentionDays, maxCountPerItem)

  beforeEach(() => {
    revision = Revision.create({
      itemUuid: Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue(),
      userUuid: Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue(),
      editedByUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      content: 'test',
      contentType: ContentType.create('Note').getValue(),
      itemsKeyId: 'test',
      encItemKey: 'test',
      authHash: 'test',
      creationDate: new Date(1),
      dates: Dates.create(new Date(1), new Date(2)).getValue(),
    }).getValue()

    dumpRepository = {} as jest.Mocked<DumpRepositoryInterface>
    dumpRepository.getRevisionFromDumpPath = jest.fn().mockReturnValue(Result.ok(revision))
    dumpRepository.removeDump = jest.fn()

    revisionRepository = {} as jest.Mocked<RevisionRepositoryInterface>
    revisionRepository.insert = jest.fn().mockReturnValue(true)
    revisionRepository.removeByItemUuidOlderThan = jest.fn()
    revisionRepository.removeByItemUuidBeyondCount = jest.fn()

    timer = {} as jest.Mocked<TimerInterface>
    // 2021-04-01T00:00:00.000Z in microseconds
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1617235200000000)

    retentionDays = 0
    maxCountPerItem = 0
  })

  it('should create a revision from file dump', async () => {
    const result = await createUseCase().execute({
      filePath: 'foobar',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(revisionRepository.insert).toHaveBeenCalled()
    expect(dumpRepository.removeDump).toHaveBeenCalled()
  })

  it('should fail if file path is empty', async () => {
    const result = await createUseCase().execute({
      filePath: '',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(revisionRepository.insert).not.toHaveBeenCalled()
    expect(dumpRepository.removeDump).not.toHaveBeenCalled()
  })

  it('should fail if revision cannot be found', async () => {
    dumpRepository.getRevisionFromDumpPath = jest.fn().mockReturnValue(Result.fail('Oops'))

    const result = await createUseCase().execute({
      filePath: 'foobar',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(revisionRepository.insert).not.toHaveBeenCalled()
    expect(dumpRepository.removeDump).toHaveBeenCalled()
  })

  it('should fail if revision cannot be inserted', async () => {
    revisionRepository.insert = jest.fn().mockReturnValue(false)

    const result = await createUseCase().execute({
      filePath: 'foobar',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(revisionRepository.insert).toHaveBeenCalled()
    expect(dumpRepository.removeDump).toHaveBeenCalled()
  })

  it('should not prune revisions when retention is unlimited (defaults)', async () => {
    await createUseCase().execute({ filePath: 'foobar' })

    expect(revisionRepository.removeByItemUuidOlderThan).not.toHaveBeenCalled()
    expect(revisionRepository.removeByItemUuidBeyondCount).not.toHaveBeenCalled()
  })

  it('should prune revisions older than the retention window when configured', async () => {
    retentionDays = 30

    await createUseCase().execute({ filePath: 'foobar' })

    expect(revisionRepository.removeByItemUuidOlderThan).toHaveBeenCalledTimes(1)
    const [itemUuidArg, cutoffArg] = (revisionRepository.removeByItemUuidOlderThan as jest.Mock).mock.calls[0]
    expect(itemUuidArg.value).toEqual('84c0f8e8-544a-4c7e-9adf-26209303bc1d')
    // 30 days before 2021-04-01T00:00:00.000Z is 2021-03-02T00:00:00.000Z
    expect((cutoffArg as Date).toISOString()).toEqual('2021-03-02T00:00:00.000Z')
    expect(revisionRepository.removeByItemUuidBeyondCount).not.toHaveBeenCalled()
  })

  it('should prune revisions beyond the max count when configured', async () => {
    maxCountPerItem = 5

    await createUseCase().execute({ filePath: 'foobar' })

    expect(revisionRepository.removeByItemUuidBeyondCount).toHaveBeenCalledTimes(1)
    const [itemUuidArg, maxCountArg] = (revisionRepository.removeByItemUuidBeyondCount as jest.Mock).mock.calls[0]
    expect(itemUuidArg.value).toEqual('84c0f8e8-544a-4c7e-9adf-26209303bc1d')
    expect(maxCountArg).toEqual(5)
    expect(revisionRepository.removeByItemUuidOlderThan).not.toHaveBeenCalled()
  })

  it('should apply both retention and max count when both configured', async () => {
    retentionDays = 30
    maxCountPerItem = 5

    await createUseCase().execute({ filePath: 'foobar' })

    expect(revisionRepository.removeByItemUuidOlderThan).toHaveBeenCalledTimes(1)
    expect(revisionRepository.removeByItemUuidBeyondCount).toHaveBeenCalledTimes(1)
  })
})
