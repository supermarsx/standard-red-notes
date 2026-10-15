import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { BaseMeInviteLinksController } from './BaseMeInviteLinksController'
import { ListSignupInviteLinks } from '../../../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { SignupInviteLink } from '../../../Domain/SignupInvite/SignupInviteLink'

describe('authenticated self-serve invite discovery', () => {
  const user = '00000000-0000-4000-8000-000000000001'
  const request = { body: {}, params: { uuid: 'link', userUuid: 'another-user' } } as unknown as Request
  const signedIn = { locals: { user: { uuid: user } } } as unknown as Response
  const anonymous = { locals: {} } as Response
  const setup = (quota: number) => {
    const config = { resolve: jest.fn().mockResolvedValue({ invitesPerUser: quota }) }
    const repository = {
      listByCreatorUser: jest.fn().mockResolvedValue([]),
      listAll: jest.fn(),
      countActiveByCreatorUser: jest.fn(),
    }
    const uses = { countByReferrer: jest.fn().mockResolvedValue(2) }
    const create = { execute: jest.fn() },
      revoke = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    const controller = new BaseMeInviteLinksController(
      config as never,
      repository as never,
      uses as never,
      create as never,
      new ListSignupInviteLinks(repository as never),
      revoke as never,
    )
    return { config, repository, uses, create, revoke, controller }
  }
  it('returns a disabled 200 state without querying private invite data', async () => {
    const { controller, repository, uses } = setup(0)
    const result = await controller.listMyInviteLinks(request, signedIn)
    expect(result.statusCode).toBe(200)
    expect(result.json).toEqual({
      enabled: false,
      invitesPerUser: 0,
      inviteLinks: [],
      invitedCount: 0,
      quota: { used: 0, total: 0 },
    })
    expect(repository.listByCreatorUser).not.toHaveBeenCalled()
    expect(uses.countByReferrer).not.toHaveBeenCalled()
  })
  it.each(['listMyInviteLinks', 'createMyInviteLink', 'revokeMyInviteLink'] as const)(
    '%s still requires authentication',
    async (method) => {
      const { controller, config } = setup(3)
      expect((await controller[method](request, anonymous)).statusCode).toBe(401)
      expect(config.resolve).not.toHaveBeenCalled()
    },
  )
  it.each(['createMyInviteLink', 'revokeMyInviteLink'] as const)(
    '%s stays forbidden when invites are disabled',
    async (method) => {
      const { controller, create, revoke } = setup(0)
      expect((await controller[method](request, signedIn)).statusCode).toBe(403)
      expect(create.execute).not.toHaveBeenCalled()
      expect(revoke.execute).not.toHaveBeenCalled()
    },
  )
  it('lists only the authenticated user’s links and returns the configured quota without raw credentials', async () => {
    const { controller, repository, uses } = setup(3)
    const now = new Date()
    const link = SignupInviteLink.create({
      hashedToken: 'a'.repeat(64),
      label: 'Own link',
      maxUses: 2,
      usedCount: 1,
      expiresAt: null,
      revoked: false,
      defaultRole: null,
      allowedDomain: null,
      createdBy: null,
      createdByUserUuid: user,
      createdByKind: 'user',
      autoApprove: false,
      createdAt: now,
      updatedAt: now,
    }).getValue()
    repository.listByCreatorUser.mockResolvedValue([link])
    const result = await controller.listMyInviteLinks(request, signedIn)
    expect(result.statusCode).toBe(200)
    expect(repository.listByCreatorUser).toHaveBeenCalledWith(user)
    expect(repository.listAll).not.toHaveBeenCalled()
    expect(uses.countByReferrer).toHaveBeenCalledWith(user)
    expect(result.json).toMatchObject({
      enabled: true,
      invitesPerUser: 3,
      quota: { used: 1, total: 3 },
      invitedCount: 2,
    })
    expect(JSON.stringify(result.json)).not.toContain(link.props.hashedToken)
    expect(JSON.stringify(result.json)).not.toContain('createdByUserUuid')
  })
})
