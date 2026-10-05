import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'

import { BaseSharedVaultInvitesController } from './BaseSharedVaultInvitesController'

/**
 * Standard Red Notes — per-account COLLABORATION GATE on invite creation.
 *
 * `collaborationEnabled` reaches the controller on `response.locals`, projected from the
 * cross-service token (`collaboration_enabled`) by the gateway's AuthMiddleware in single-container
 * mode and by the syncing-server's own auth middleware in multi-container mode. An account with
 * collaboration switched off must not be able to hand a vault key to anybody.
 *
 * The gate is DEFAULT-ON by design: a token minted before the flag existed, or any token that simply
 * omits it, leaves `locals.collaborationEnabled` undefined, and undefined must NOT lock the account
 * out of collaboration. That makes "absent" and "false" two behaviours a single `=== false`
 * comparison has to keep apart — flip it to a truthiness test and every legacy token loses
 * collaboration silently. Nothing covered either branch before this spec.
 */
describe('BaseSharedVaultInvitesController collaboration gate', () => {
  let inviteUserToSharedVault: { execute: jest.Mock }
  let sharedVaultInviteHttpMapper: { toProjection: jest.Mock }

  const anyDep = {} as never

  const createController = () =>
    new BaseSharedVaultInvitesController(
      inviteUserToSharedVault as never,
      anyDep,
      anyDep,
      anyDep,
      anyDep,
      anyDep,
      anyDep,
      anyDep,
      sharedVaultInviteHttpMapper as never,
    )

  const request = (): Request =>
    ({
      params: { sharedVaultUuid: 'shared-vault-1' },
      body: {
        recipient_uuid: 'recipient-1',
        encrypted_message: 'encrypted',
        permission: 'write',
      },
    }) as unknown as Request

  const response = (locals: Record<string, unknown>): Response => ({ locals }) as unknown as Response

  beforeEach(() => {
    inviteUserToSharedVault = { execute: jest.fn().mockResolvedValue(Result.ok({ invite: 'domain-invite' })) }
    sharedVaultInviteHttpMapper = { toProjection: jest.fn().mockReturnValue({ uuid: 'invite-1' }) }
  })

  it('refuses to create an invite for an account whose collaboration is disabled', async () => {
    const controller = createController()

    const result = await controller.createSharedVaultInvite(
      request(),
      response({ user: { uuid: 'user-1' }, collaborationEnabled: false }),
    )

    expect(result.statusCode).toBe(403)
    expect((result as results.JsonResult).json).toEqual({
      error: { message: 'Collaboration is disabled for this account' },
    })
    // The point of the gate: the invite is never created, not merely hidden from the response.
    expect(inviteUserToSharedVault.execute).not.toHaveBeenCalled()
  })

  it('creates the invite when collaboration is explicitly enabled', async () => {
    const controller = createController()

    const result = await controller.createSharedVaultInvite(
      request(),
      response({ user: { uuid: 'user-1' }, collaborationEnabled: true }),
    )

    expect(inviteUserToSharedVault.execute).toHaveBeenCalledTimes(1)
    expect(inviteUserToSharedVault.execute).toHaveBeenCalledWith({
      sharedVaultUuid: 'shared-vault-1',
      senderUuid: 'user-1',
      recipientUuid: 'recipient-1',
      encryptedMessage: 'encrypted',
      permission: 'write',
    })
    expect((result as results.JsonResult).json).toEqual({ invite: { uuid: 'invite-1' } })
  })

  it('creates the invite when the token omits the flag entirely (default-on, not default-deny)', async () => {
    const controller = createController()
    const locals = { user: { uuid: 'user-1' } }

    // Precondition: the flag really is absent rather than set to true, which is the whole distinction
    // this case exists to pin.
    expect('collaborationEnabled' in locals).toBe(false)

    const result = await controller.createSharedVaultInvite(request(), response(locals))

    expect(inviteUserToSharedVault.execute).toHaveBeenCalledTimes(1)
    expect((result as results.JsonResult).json).toEqual({ invite: { uuid: 'invite-1' } })
  })
})
