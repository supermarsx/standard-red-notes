import 'reflect-metadata'

import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'
import { SignupInviteUseRepositoryInterface } from '../../SignupInvite/SignupInviteUseRepositoryInterface'
import { SignupInviteLink } from '../../SignupInvite/SignupInviteLink'
import { SignupInviteLinkProps } from '../../SignupInvite/SignupInviteLinkProps'
import { SignupInviteUse } from '../../SignupInvite/SignupInviteUse'
import { UniqueEntityId } from '@standardnotes/domain-core'

import { ConsumeSignupInvite } from './ConsumeSignupInvite'

describe('ConsumeSignupInvite', () => {
  let repo: jest.Mocked<SignupInviteLinkRepositoryInterface>

  const link = (overrides: Partial<SignupInviteLinkProps> = {}): SignupInviteLink =>
    SignupInviteLink.create(
      {
        hashedToken: 'h',
        label: null,
        maxUses: 1,
        usedCount: 0,
        expiresAt: null,
        revoked: false,
        defaultRole: null,
        allowedDomain: null,
        createdBy: null,
        createdByUserUuid: null,
        createdByKind: 'admin',
        autoApprove: true,
        createdAt: new Date(1),
        updatedAt: new Date(1),
        ...overrides,
      },
      new UniqueEntityId('link-uuid'),
    ).getValue()

  beforeEach(() => {
    repo = {
      save: jest.fn(),
      findByHashedToken: jest.fn(),
      findByUuid: jest.fn(),
      consumeSlot: jest.fn(),
      listAll: jest.fn(),
      listByCreatorUser: jest.fn(),
      countActiveByCreatorUser: jest.fn(),
      revokeByUuid: jest.fn(),
    } as unknown as jest.Mocked<SignupInviteLinkRepositoryInterface>
  })

  const dto = { token: 'raw', email: 'a@b.co', newUserUuid: 'u1', now: new Date(1000) }

  it('returns invalid for an empty token without touching the repo', async () => {
    const result = await new ConsumeSignupInvite(repo).execute({ ...dto, token: '' })

    expect(result).toEqual({ outcome: 'invalid' })
    expect(repo.findByHashedToken).not.toHaveBeenCalled()
  })

  it('returns invalid when no link matches', async () => {
    repo.findByHashedToken.mockResolvedValue(null)

    expect(await new ConsumeSignupInvite(repo).execute(dto)).toEqual({ outcome: 'invalid' })
    expect(repo.consumeSlot).not.toHaveBeenCalled()
  })

  it('returns consumed with metadata on a successful atomic consume', async () => {
    repo.findByHashedToken.mockResolvedValue(
      link({ defaultRole: 'PRO_USER', autoApprove: false, createdByUserUuid: 'ref-1' }),
    )
    repo.consumeSlot.mockResolvedValue(true)

    const result = await new ConsumeSignupInvite(repo).execute(dto)

    expect(result).toEqual({
      outcome: 'consumed',
      inviteLinkUuid: 'link-uuid',
      defaultRole: 'PRO_USER',
      allowedDomain: null,
      autoApprove: false,
      referrerUserUuid: 'ref-1',
    })
  })

  it('returns invalid when the atomic consume reports no slot (exhausted/expired/revoked)', async () => {
    repo.findByHashedToken.mockResolvedValue(link())
    repo.consumeSlot.mockResolvedValue(false)

    expect(await new ConsumeSignupInvite(repo).execute(dto)).toEqual({ outcome: 'invalid' })
  })

  it('enforces the per-link allowed_domain BEFORE consuming (mismatch never consumes)', async () => {
    repo.findByHashedToken.mockResolvedValue(link({ allowedDomain: 'company.com' }))

    const result = await new ConsumeSignupInvite(repo).execute({ ...dto, email: 'a@other.com' })

    expect(result).toEqual({ outcome: 'invalid' })
    expect(repo.consumeSlot).not.toHaveBeenCalled()
  })

  it('accepts a subdomain of the allowed_domain', async () => {
    repo.findByHashedToken.mockResolvedValue(link({ allowedDomain: 'company.com' }))
    repo.consumeSlot.mockResolvedValue(true)

    const result = await new ConsumeSignupInvite(repo).execute({ ...dto, email: 'a@mail.company.com' })

    expect(result.outcome).toBe('consumed')
  })

  it('returns error when the repository throws (caller decides fail-open vs closed)', async () => {
    repo.findByHashedToken.mockRejectedValue(new Error('db down'))

    expect(await new ConsumeSignupInvite(repo).execute(dto)).toEqual({ outcome: 'error' })
  })

  it('writes an attribution use row on a successful consume (referrer from the link)', async () => {
    repo.findByHashedToken.mockResolvedValue(link({ createdByUserUuid: 'ref-1', createdByKind: 'user' }))
    repo.consumeSlot.mockResolvedValue(true)
    const useRepo = {
      save: jest.fn(),
      countByReferrer: jest.fn(),
      countByLink: jest.fn(),
    } as unknown as jest.Mocked<SignupInviteUseRepositoryInterface>

    const result = await new ConsumeSignupInvite(repo, useRepo).execute(dto)

    expect(result.outcome).toBe('consumed')
    expect(useRepo.save).toHaveBeenCalledTimes(1)
    const savedUse = (useRepo.save as jest.Mock).mock.calls[0][0] as SignupInviteUse
    expect(savedUse.props.newUserUuid).toBe('u1')
    expect(savedUse.props.referrerUserUuid).toBe('ref-1')
    expect(savedUse.props.inviteLinkUuid).toBe('link-uuid')
  })

  it('still reports consumed when the attribution write throws (best-effort)', async () => {
    repo.findByHashedToken.mockResolvedValue(link())
    repo.consumeSlot.mockResolvedValue(true)
    const useRepo = {
      save: jest.fn().mockRejectedValue(new Error('write failed')),
      countByReferrer: jest.fn(),
      countByLink: jest.fn(),
    } as unknown as jest.Mocked<SignupInviteUseRepositoryInterface>

    const result = await new ConsumeSignupInvite(repo, useRepo).execute(dto)

    expect(result.outcome).toBe('consumed')
  })
})
