import 'reflect-metadata'
import { RoleName } from '@standardnotes/domain-core'

import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'

import { CreateSignupInviteLink } from './CreateSignupInviteLink'

describe('CreateSignupInviteLink', () => {
  let repo: jest.Mocked<SignupInviteLinkRepositoryInterface>

  beforeEach(() => {
    repo = { save: jest.fn() } as unknown as jest.Mocked<SignupInviteLinkRepositoryInterface>
  })

  it('mints an admin link and returns a 64-hex raw token exactly once', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({ creatorKind: 'admin', adminUuid: 'admin-1' })

    expect(result.isFailed()).toBe(false)
    const { link, token } = result.getValue()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(link.props.createdByKind).toBe('admin')
    expect(link.props.createdBy).toBe('admin-1')
    expect(repo.save).toHaveBeenCalledTimes(1)
  })

  it('admin link honors default_role, allowed_domain and auto_approve (default true)', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({
      creatorKind: 'admin',
      defaultRole: RoleName.NAMES.ProUser,
      allowedDomain: '@Company.COM',
    })

    const { link } = result.getValue()
    expect(link.props.defaultRole).toBe(RoleName.NAMES.ProUser)
    expect(link.props.allowedDomain).toBe('company.com')
    expect(link.props.autoApprove).toBe(true)
  })

  it('admin link cannot set the ADMIN role as the default (privilege guard)', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({
      creatorKind: 'admin',
      defaultRole: RoleName.NAMES.AdminUser,
    })

    expect(result.isFailed()).toBe(true)
  })

  it('USER link forces auto_approve=false and carries the referrer', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({
      creatorKind: 'user',
      creatorUserUuid: 'user-1',
      autoApprove: true, // ignored
    })

    const { link } = result.getValue()
    expect(link.props.autoApprove).toBe(false)
    expect(link.props.createdByKind).toBe('user')
    expect(link.props.createdByUserUuid).toBe('user-1')
    expect(link.props.createdBy).toBeNull()
  })

  it('USER link REFUSES a role override (no privilege escalation)', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({
      creatorKind: 'user',
      creatorUserUuid: 'user-1',
      defaultRole: RoleName.NAMES.ProUser,
    })

    expect(result.isFailed()).toBe(true)
    expect(repo.save).not.toHaveBeenCalled()
  })

  it('USER link REFUSES an email-domain lock', async () => {
    const result = await new CreateSignupInviteLink(repo).execute({
      creatorKind: 'user',
      creatorUserUuid: 'user-1',
      allowedDomain: 'company.com',
    })

    expect(result.isFailed()).toBe(true)
  })

  it('rejects an out-of-range maxUses', async () => {
    expect((await new CreateSignupInviteLink(repo).execute({ creatorKind: 'admin', maxUses: 0 })).isFailed()).toBe(true)
    expect(
      (await new CreateSignupInviteLink(repo).execute({ creatorKind: 'admin', maxUses: 999999 })).isFailed(),
    ).toBe(true)
  })
})
