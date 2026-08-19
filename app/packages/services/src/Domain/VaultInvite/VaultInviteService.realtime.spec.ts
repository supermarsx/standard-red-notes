import { ClientDisplayableError } from '@standardnotes/responses'

import { InviteRealtimeEvent } from '../Invite/InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from '../Invite/InviteRealtimeEventConsumer'
import { VaultInviteService } from './VaultInviteService'

const sharedVaultEvent: InviteRealtimeEvent = {
  version: 1,
  eventId: '00000000-0000-4000-8000-000000000001',
  streamPosition: 'cursor-1',
  kind: 'shared-vault-invite',
  action: 'created',
  inviteUuid: '10000000-0000-4000-8000-000000000001',
  sharedVaultUuid: '20000000-0000-4000-8000-000000000001',
  occurredAt: 1,
}

const createService = (signedIn = true): VaultInviteService => {
  const service = Object.create(VaultInviteService.prototype) as VaultInviteService
  Object.assign(service, {
    session: { isSignedIn: jest.fn().mockReturnValue(signedIn), userUuid: 'account-a' },
    realtimeReload: undefined,
    realtimeReloadDirty: false,
  })
  return service
}

describe('VaultInviteService realtime invalidations', () => {
  it('authoritatively reloads inbound invitations', async () => {
    const service = createService()
    jest.spyOn(service, 'downloadInboundInvites').mockResolvedValue([])

    await service.handleInviteRealtimeEvents([sharedVaultEvent])

    expect(service.downloadInboundInvites).toHaveBeenCalledTimes(1)
  })

  it('runs one trailing reload when an invalidation arrives during an in-flight reload', async () => {
    const service = createService()
    let release!: () => void
    const reload = new Promise<[]>((resolve) => {
      release = () => resolve([])
    })
    jest.spyOn(service, 'downloadInboundInvites').mockReturnValueOnce(reload).mockResolvedValueOnce([])

    const first = service.handleInviteRealtimeEvents([sharedVaultEvent])
    const second = service.handleInviteRealtimeEvents([{ ...sharedVaultEvent, action: 'updated' }])
    release()
    await Promise.all([first, second])

    expect(service.downloadInboundInvites).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the authoritative reload fails', async () => {
    const service = createService()
    jest.spyOn(service, 'downloadInboundInvites').mockResolvedValue(ClientDisplayableError.FromString('request failed'))

    await expect(service.handleInviteRealtimeEvents([sharedVaultEvent])).rejects.toThrow(
      'Could not reconcile shared-vault invitations',
    )
  })

  it('does not replace cached invitations when the exact session changes during the HTTP reload', async () => {
    let release!: (value: { data: { invites: [] } }) => void
    const response = new Promise<{ data: { invites: [] } }>((resolve) => {
      release = resolve
    })
    const existing = { invite: { uuid: 'existing-invite' } }
    const service = createService()
    Object.assign(service, {
      pendingInvites: { 'existing-invite': existing },
      invitesServer: { getInboundUserInvites: jest.fn().mockReturnValue(response) },
    })
    let current = true
    const context = {
      sessionScope: 'account-a',
      sessionEpoch: 1,
      signal: new AbortController().signal,
      isCurrent: () => current,
      assertCurrent: () => {
        if (!current) {
          throw new Error('session changed')
        }
      },
    } satisfies InviteRealtimeHandlerContext

    const applying = service.handleInviteRealtimeEvents([sharedVaultEvent], context)
    await Promise.resolve()
    current = false
    release({ data: { invites: [] } })

    await expect(applying).rejects.toThrow('session changed')
    expect(service.getCachedPendingInviteRecords()).toEqual([existing])
  })

  it('rejects an invalidation after sign-out and ignores unrelated invitation kinds', async () => {
    const service = createService(false)
    jest.spyOn(service, 'downloadInboundInvites').mockResolvedValue([])

    await expect(service.handleInviteRealtimeEvents([sharedVaultEvent])).rejects.toThrow('authenticated session')
    await expect(
      service.handleInviteRealtimeEvents([
        {
          version: 1,
          eventId: sharedVaultEvent.eventId,
          streamPosition: sharedVaultEvent.streamPosition,
          kind: 'subscription-invite',
          action: sharedVaultEvent.action,
          inviteUuid: sharedVaultEvent.inviteUuid,
          occurredAt: sharedVaultEvent.occurredAt,
        },
      ]),
    ).resolves.toBeUndefined()
    expect(service.downloadInboundInvites).not.toHaveBeenCalled()
  })
})
