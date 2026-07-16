import { AuditLogRepositoryInterface } from '../../AuditLog/AuditLogRepositoryInterface'

import { QueryAuditLog } from './QueryAuditLog'

describe('QueryAuditLog', () => {
  let repository: jest.Mocked<AuditLogRepositoryInterface>

  beforeEach(() => {
    repository = {} as jest.Mocked<AuditLogRepositoryInterface>
    repository.find = jest.fn().mockResolvedValue({ entries: [], total: 0 })
  })

  it('uses bounded pagination defaults', async () => {
    const result = await new QueryAuditLog(repository).execute({})

    expect(repository.find).toHaveBeenCalledWith({ limit: 50, offset: 0 })
    expect(result.getValue()).toEqual({ entries: [], total: 0, limit: 50, offset: 0 })
  })

  it('passes non-empty filters and valid inclusive dates to the repository', async () => {
    repository.find.mockResolvedValue({ entries: [], total: 17 })

    const result = await new QueryAuditLog(repository).execute({
      actorUuid: 'actor-uuid',
      action: 'user.suspended',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
      limit: 500,
      offset: 4,
    })

    expect(repository.find).toHaveBeenCalledWith({
      actorUuid: 'actor-uuid',
      action: 'user.suspended',
      createdAfter: Date.parse('2026-01-01T00:00:00.000Z'),
      createdBefore: Date.parse('2026-01-31T23:59:59.999Z'),
      limit: 200,
      offset: 4,
    })
    expect(result.getValue()).toMatchObject({ total: 17, limit: 200, offset: 4 })
  })

  it('ignores empty or invalid filters and clamps pagination to its lower bounds', async () => {
    const result = await new QueryAuditLog(repository).execute({
      actorUuid: '',
      action: '',
      from: 'not-a-date',
      to: '',
      limit: 0,
      offset: -10,
    })

    expect(repository.find).toHaveBeenCalledWith({ limit: 1, offset: 0 })
    expect(result.getValue()).toMatchObject({ limit: 1, offset: 0 })
  })
})
