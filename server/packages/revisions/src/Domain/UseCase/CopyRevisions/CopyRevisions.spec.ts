import { Result } from '@standardnotes/domain-core'
import { Revision } from '../../Revision/Revision'
import { RevisionRepositoryInterface } from '../../Revision/RevisionRepositoryInterface'
import { CopyRevisions } from './CopyRevisions'

describe('CopyRevisions', () => {
  let revisionRepository: RevisionRepositoryInterface

  const createUseCase = () => new CopyRevisions(revisionRepository)

  beforeEach(() => {
    revisionRepository = {} as jest.Mocked<RevisionRepositoryInterface>
    revisionRepository.countByItemUuid = jest.fn().mockResolvedValue(0)
    revisionRepository.findByItemUuid = jest.fn().mockReturnValue([{} as jest.Mocked<Revision>])
    revisionRepository.insert = jest.fn()
    revisionRepository.insertMany = jest.fn().mockResolvedValue(true)
  })

  it('should not copy revisions to new item if revision creation fails', async () => {
    const revisionMock = jest.spyOn(Revision, 'create')
    revisionMock.mockImplementation(() => Result.fail('Oops'))

    const result = await createUseCase().execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(revisionRepository.insertMany).not.toHaveBeenCalled()

    revisionMock.mockRestore()
  })

  it('should copy revisions to new item', async () => {
    const result = await createUseCase().execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(revisionRepository.insertMany).toHaveBeenCalled()
    expect(result.getValue()).toEqual('Revisions copied')
  })

  it('should not copy revisions for an invalid item uuid', async () => {
    const result = await createUseCase().execute({
      originalItemUuid: '1-2-3',
      newItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should not delete revision for a an invalid new item uuid', async () => {
    const result = await createUseCase().execute({
      newItemUuid: '1-2-3',
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should be idempotent: skip copying when the target item already has revisions', async () => {
    revisionRepository.countByItemUuid = jest.fn().mockResolvedValue(3)

    const result = await createUseCase().execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '9f6d1b2c-544a-4c7e-9adf-26209303bc1d',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual('Revisions already copied')
    expect(revisionRepository.findByItemUuid).not.toHaveBeenCalled()
    expect(revisionRepository.insertMany).not.toHaveBeenCalled()
  })

  it('should not produce duplicate copies when the copy request is redelivered', async () => {
    const useCase = createUseCase()

    // First delivery: target is empty, copy proceeds.
    const first = await useCase.execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '9f6d1b2c-544a-4c7e-9adf-26209303bc1d',
    })
    expect(first.isFailed()).toBeFalsy()
    expect(revisionRepository.insertMany).toHaveBeenCalledTimes(1)

    // Redelivery: target now already has the copied revisions, so it is a no-op.
    revisionRepository.countByItemUuid = jest.fn().mockResolvedValue(1)
    const second = await useCase.execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '9f6d1b2c-544a-4c7e-9adf-26209303bc1d',
    })
    expect(second.isFailed()).toBeFalsy()
    expect(revisionRepository.insertMany).toHaveBeenCalledTimes(1)
  })

  it('should insert all copies in a single transactional batch rather than one-by-one', async () => {
    revisionRepository.findByItemUuid = jest
      .fn()
      .mockResolvedValue([{ props: {} } as Revision, { props: {} } as Revision, { props: {} } as Revision])

    await createUseCase().execute({
      originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      newItemUuid: '9f6d1b2c-544a-4c7e-9adf-26209303bc1d',
    })

    expect(revisionRepository.insertMany).toHaveBeenCalledTimes(1)
    expect((revisionRepository.insertMany as jest.Mock).mock.calls[0][0]).toHaveLength(3)
    expect(revisionRepository.insert).not.toHaveBeenCalled()
  })

  it('should leave no partial copy when the transactional insert fails mid-copy', async () => {
    revisionRepository.insertMany = jest.fn().mockRejectedValue(new Error('DB write failed'))

    await expect(
      createUseCase().execute({
        originalItemUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
        newItemUuid: '9f6d1b2c-544a-4c7e-9adf-26209303bc1d',
      }),
    ).rejects.toThrow('DB write failed')

    // No per-row inserts happened; the atomic insertMany is the only write path,
    // so its rollback leaves the target with no partial rows.
    expect(revisionRepository.insert).not.toHaveBeenCalled()
  })
})
