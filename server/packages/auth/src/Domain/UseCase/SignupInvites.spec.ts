import { SignupInviteLink } from '../SignupInvite/SignupInviteLink'
import { SignupInviteLinkProps } from '../SignupInvite/SignupInviteLinkProps'
import { SignupInviteLinkRepositoryInterface } from '../SignupInvite/SignupInviteLinkRepositoryInterface'
import { AdminUserListResult, UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { ListPendingUsers } from './ListPendingUsers/ListPendingUsers'
import { ListSignupInviteLinks } from './ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from './RevokeSignupInviteLink/RevokeSignupInviteLink'

const baseProps = (overrides: Partial<SignupInviteLinkProps> = {}): SignupInviteLinkProps => ({
  hashedToken: 'hash',
  label: null,
  maxUses: 2,
  usedCount: 0,
  expiresAt: null,
  revoked: false,
  defaultRole: null,
  allowedDomain: null,
  createdBy: 'admin-uuid',
  createdByUserUuid: null,
  createdByKind: 'admin',
  autoApprove: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

const createLink = (overrides: Partial<SignupInviteLinkProps> = {}): SignupInviteLink =>
  SignupInviteLink.create(baseProps(overrides)).getValue()

const createInviteRepository = (): jest.Mocked<SignupInviteLinkRepositoryInterface> => {
  const repository = {} as jest.Mocked<SignupInviteLinkRepositoryInterface>
  repository.findByUuid = jest.fn().mockResolvedValue(null)
  repository.listAll = jest.fn().mockResolvedValue([])
  repository.listByCreatorUser = jest.fn().mockResolvedValue([])
  repository.revokeByUuid = jest.fn().mockResolvedValue(true)

  return repository
}

describe('SignupInviteLink', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')

  it('reports active links and their remaining capacity', () => {
    const link = createLink({ maxUses: 3, usedCount: 1 })

    expect(link.isExpired(now)).toBe(false)
    expect(link.isExhausted()).toBe(false)
    expect(link.remainingUses()).toBe(2)
    expect(link.status(now)).toBe('active')
    expect(link.isActive(now)).toBe(true)
  })

  it('reports revoked links before expired or exhausted states', () => {
    const link = createLink({
      revoked: true,
      usedCount: 3,
      maxUses: 2,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(link.isExpired(now)).toBe(true)
    expect(link.isExhausted()).toBe(true)
    expect(link.remainingUses()).toBe(0)
    expect(link.status(now)).toBe('revoked')
    expect(link.isActive(now)).toBe(false)
  })

  it('distinguishes expired and exhausted links', () => {
    const expired = createLink({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })
    const exhausted = createLink({ maxUses: 1, usedCount: 1 })

    expect(expired.status(now)).toBe('expired')
    expect(exhausted.status(now)).toBe('exhausted')
  })
})

describe('RevokeSignupInviteLink', () => {
  let repository: jest.Mocked<SignupInviteLinkRepositoryInterface>

  beforeEach(() => {
    repository = createInviteRepository()
  })

  it('soft-revokes an admin-selected link after trimming its uuid', async () => {
    repository.findByUuid.mockResolvedValue(createLink())

    const result = await new RevokeSignupInviteLink(repository).execute({ uuid: '  link-uuid  ' })

    expect(result.getValue()).toEqual({ uuid: 'link-uuid' })
    expect(repository.revokeByUuid).toHaveBeenCalledWith('link-uuid')
  })

  it('allows a creator to revoke their own link', async () => {
    repository.findByUuid.mockResolvedValue(createLink({ createdBy: null, createdByUserUuid: 'creator-uuid' }))

    const result = await new RevokeSignupInviteLink(repository).execute({
      uuid: 'link-uuid',
      requesterUserUuid: 'creator-uuid',
    })

    expect(result.isFailed()).toBe(false)
    expect(repository.revokeByUuid).toHaveBeenCalledWith('link-uuid')
  })

  it("rejects missing ids, unknown links, and attempts to revoke another creator's link", async () => {
    const useCase = new RevokeSignupInviteLink(repository)

    expect((await useCase.execute({ uuid: '   ' })).getError()).toContain('required')
    expect((await useCase.execute({ uuid: 'missing' })).getError()).toContain('No invite link')

    repository.findByUuid.mockResolvedValue(createLink({ createdBy: null, createdByUserUuid: 'owner-uuid' }))
    const forbidden = await useCase.execute({ uuid: 'link-uuid', requesterUserUuid: 'different-user' })

    expect(forbidden.getError()).toContain('your own')
    expect(repository.revokeByUuid).not.toHaveBeenCalled()
  })
})

describe('ListSignupInviteLinks', () => {
  it('uses the all-links and creator-scoped repository paths', async () => {
    const repository = createInviteRepository()
    const adminLink = createLink()
    const userLink = createLink({ createdBy: null, createdByUserUuid: 'creator-uuid', createdByKind: 'user' })
    repository.listAll.mockResolvedValue([adminLink])
    repository.listByCreatorUser.mockResolvedValue([userLink])
    const useCase = new ListSignupInviteLinks(repository)

    expect((await useCase.execute({})).getValue()).toEqual([adminLink])
    expect((await useCase.execute({ creatorUserUuid: null as unknown as string })).getValue()).toEqual([adminLink])
    expect((await useCase.execute({ creatorUserUuid: 'creator-uuid' })).getValue()).toEqual([userLink])
    expect(repository.listByCreatorUser).toHaveBeenCalledWith('creator-uuid')
  })
})

describe('ListPendingUsers', () => {
  let repository: jest.Mocked<UserRepositoryInterface>
  const emptyResult: AdminUserListResult = { rows: [], total: 0 }

  beforeEach(() => {
    repository = {} as jest.Mocked<UserRepositoryInterface>
    repository.findUsersForAdmin = jest.fn().mockResolvedValue(emptyResult)
  })

  it('requests the pending queue with stable defaults', async () => {
    const result = await new ListPendingUsers(repository).execute({})

    expect(result.getValue()).toBe(emptyResult)
    expect(repository.findUsersForAdmin).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      sort: 'createdAt',
      approved: false,
    })
  })

  it('normalizes invalid pagination and caps oversized pages', async () => {
    const useCase = new ListPendingUsers(repository)

    await useCase.execute({ limit: Number.NaN, offset: -1 })
    expect(repository.findUsersForAdmin).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100, offset: 0, approved: false }),
    )

    await useCase.execute({ limit: 2000, offset: Number.POSITIVE_INFINITY })
    expect(repository.findUsersForAdmin).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1500, offset: 0, approved: false }),
    )
  })

  it('passes valid pagination and sorting through unchanged', async () => {
    await new ListPendingUsers(repository).execute({ limit: 25, offset: 50, sort: 'email' })

    expect(repository.findUsersForAdmin).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      sort: 'email',
      approved: false,
    })
  })
})
