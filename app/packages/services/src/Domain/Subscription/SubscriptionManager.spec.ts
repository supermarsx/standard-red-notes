import { ApplicationStage } from './../Application/ApplicationStage'
import { SessionEvent } from './../Session/SessionEvent'
import { ApplicationEvent } from './../Event/ApplicationEvent'
import { StorageServiceInterface } from './../Storage/StorageServiceInterface'
import { SessionsClientInterface } from './../Session/SessionsClientInterface'
import { SubscriptionApiServiceInterface } from '@standardnotes/api'
import { Invitation } from '@standardnotes/models'
import { InternalEventBusInterface } from '..'
import { SubscriptionManager } from './SubscriptionManager'
import { IsApplicationUsingThirdPartyHost } from '../UseCase/IsApplicationUsingThirdPartyHost'
import { Result } from '@standardnotes/domain-core'
import { InviteRealtimeEvent } from '../Invite/InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from '../Invite/InviteRealtimeEventConsumer'
import { SubscriptionManagerEvent } from './SubscriptionManagerEvent'

describe('SubscriptionManager', () => {
  let subscriptionApiService: SubscriptionApiServiceInterface
  let internalEventBus: InternalEventBusInterface
  let sessions: SessionsClientInterface
  let storage: StorageServiceInterface
  let isApplicationUsingThirdPartyHostUseCase: IsApplicationUsingThirdPartyHost

  const createManager = () =>
    new SubscriptionManager(
      subscriptionApiService,
      sessions,
      storage,
      isApplicationUsingThirdPartyHostUseCase,
      internalEventBus,
    )

  const subscriptionInviteEvent: InviteRealtimeEvent = {
    version: 1,
    eventId: '00000000-0000-4000-8000-000000000001',
    streamPosition: 'cursor-1',
    kind: 'subscription-invite',
    action: 'created',
    inviteUuid: '10000000-0000-4000-8000-000000000001',
    occurredAt: 1,
  }

  beforeEach(() => {
    subscriptionApiService = {} as jest.Mocked<SubscriptionApiServiceInterface>
    subscriptionApiService.cancelInvite = jest.fn()
    subscriptionApiService.acceptInvite = jest.fn()
    subscriptionApiService.invite = jest.fn()
    subscriptionApiService.listInvites = jest.fn().mockResolvedValue({ data: { invitations: [] } })
    subscriptionApiService.getUserSubscription = jest.fn().mockResolvedValue({ data: { subscription: undefined } })

    sessions = {} as jest.Mocked<SessionsClientInterface>
    sessions.isSignedIn = jest.fn().mockReturnValue(true)
    Object.defineProperty(sessions, 'userUuid', { configurable: true, value: 'account-a' })

    storage = {} as jest.Mocked<StorageServiceInterface>
    storage.setValue = jest.fn()

    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.addEventHandler = jest.fn()
    internalEventBus.publish = jest.fn()

    isApplicationUsingThirdPartyHostUseCase = {} as jest.Mocked<IsApplicationUsingThirdPartyHost>
    isApplicationUsingThirdPartyHostUseCase.execute = jest.fn().mockReturnValue(Result.ok(false))
  })

  describe('event handling', () => {
    it('should fetch subscriptions when the application has launched', async () => {
      const manager = createManager()
      jest.spyOn(manager, 'fetchOnlineSubscription')
      jest.spyOn(manager, 'fetchAvailableSubscriptions')

      await manager.handleEvent({ type: ApplicationEvent.Launched, payload: {} })

      expect(manager.fetchOnlineSubscription).toHaveBeenCalledTimes(1)
      expect(manager.fetchAvailableSubscriptions).toHaveBeenCalledTimes(1)
    })

    it('should fetch online subscription when user roles have changed', async () => {
      const manager = createManager()
      jest.spyOn(manager, 'fetchOnlineSubscription')

      await manager.handleEvent({ type: ApplicationEvent.UserRolesChanged, payload: {} })

      expect(manager.fetchOnlineSubscription).toHaveBeenCalledTimes(1)
    })

    it('should fetch online subscription when session is restored', async () => {
      const manager = createManager()
      jest.spyOn(manager, 'fetchOnlineSubscription')

      await manager.handleEvent({ type: SessionEvent.Restored, payload: {} })

      expect(manager.fetchOnlineSubscription).toHaveBeenCalledTimes(1)
    })

    it('should fetch online subscription when user has signed in', async () => {
      const manager = createManager()
      jest.spyOn(manager, 'fetchOnlineSubscription')

      await manager.handleEvent({ type: ApplicationEvent.SignedIn, payload: {} })

      expect(manager.fetchOnlineSubscription).toHaveBeenCalledTimes(1)
    })

    it('should handle stage change and notify event', async () => {
      const manager = createManager()
      jest.spyOn(manager, 'loadSubscriptionFromStorage')
      storage.getValue = jest.fn().mockReturnValue({})

      await manager.handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: { stage: ApplicationStage.StorageDecrypted_09 },
      })

      expect(manager.loadSubscriptionFromStorage).toHaveBeenCalled()
    })
  })

  it('should invite user by email to a shared subscription', async () => {
    subscriptionApiService.invite = jest.fn().mockReturnValue({ data: { success: true } })

    expect(await createManager().inviteToSubscription('test@test.te')).toBeTruthy()
  })

  it('should not invite user by email if the api fails to do so', async () => {
    subscriptionApiService.invite = jest.fn().mockReturnValue({ data: { error: 'foobar' } })

    expect(await createManager().inviteToSubscription('test@test.te')).toBeFalsy()
  })

  it('should not invite user by email if the api throws an error', async () => {
    subscriptionApiService.invite = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(await createManager().inviteToSubscription('test@test.te')).toBeFalsy()
  })

  it('should cancel invite to a shared subscription', async () => {
    subscriptionApiService.cancelInvite = jest.fn().mockReturnValue({ data: { success: true } })

    expect(await createManager().cancelInvitation('1-2-3')).toBeTruthy()
  })

  it('should not cancel invite if the api fails to do so', async () => {
    subscriptionApiService.cancelInvite = jest.fn().mockReturnValue({ data: { error: 'foobar' } })

    expect(await createManager().cancelInvitation('1-2-3')).toBeFalsy()
  })

  it('should not cancel invite if the api throws an error', async () => {
    subscriptionApiService.cancelInvite = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(await createManager().cancelInvitation('1-2-3')).toBeFalsy()
  })

  it('should list invites to a shared subscription', async () => {
    const invitation = {
      uuid: '1-2-3',
    } as jest.Mocked<Invitation>
    subscriptionApiService.listInvites = jest.fn().mockReturnValue({ data: { invitations: [invitation] } })

    expect(await createManager().listSubscriptionInvitations()).toEqual([invitation])
  })

  it('should return an empty list of invites if the api fails to fetch them', async () => {
    subscriptionApiService.listInvites = jest.fn().mockReturnValue({ data: { error: 'foobar' } })

    expect(await createManager().listSubscriptionInvitations()).toEqual([])
  })

  it('should return an empty list of invites if the api throws an error', async () => {
    subscriptionApiService.listInvites = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(await createManager().listSubscriptionInvitations()).toEqual([])
  })

  it('should accept invite to a shared subscription', async () => {
    subscriptionApiService.acceptInvite = jest.fn().mockReturnValue({ data: { success: true } })

    expect(await createManager().acceptInvitation('1-2-3')).toEqual({ success: true })
  })

  it('notifies invitation observers once for a realtime subscription batch', async () => {
    const manager = createManager()

    await manager.handleInviteRealtimeEvents([
      subscriptionInviteEvent,
      { ...subscriptionInviteEvent, eventId: '00000000-0000-4000-8000-000000000002', action: 'updated' },
    ])

    expect(internalEventBus.publish).toHaveBeenCalledTimes(1)
    expect(internalEventBus.publish).toHaveBeenCalledWith({
      type: SubscriptionManagerEvent.DidChangeInvitations,
      payload: undefined,
    })
  })

  it('refreshes account entitlements after an accepted realtime invitation', async () => {
    const manager = createManager()

    await manager.handleInviteRealtimeEvents([{ ...subscriptionInviteEvent, action: 'accepted' }])

    expect(subscriptionApiService.getUserSubscription).toHaveBeenCalledTimes(1)
  })

  it('waits for a successful authoritative invitation reload before publishing the durable change', async () => {
    let release!: (value: { data: { invitations: Invitation[] } }) => void
    subscriptionApiService.listInvites = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const manager = createManager()

    const applying = manager.handleInviteRealtimeEvents([subscriptionInviteEvent])
    await Promise.resolve()
    expect(internalEventBus.publish).not.toHaveBeenCalled()

    release({ data: { invitations: [] } })
    await applying
    expect(internalEventBus.publish).toHaveBeenCalledWith({
      type: SubscriptionManagerEvent.DidChangeInvitations,
      payload: undefined,
    })
  })

  it('rejects a failed realtime invitation reload without publishing or caching a replacement', async () => {
    subscriptionApiService.listInvites = jest.fn().mockResolvedValue({ data: { error: 'unavailable' } })
    const manager = createManager()

    await expect(manager.handleInviteRealtimeEvents([subscriptionInviteEvent])).rejects.toThrow(
      'Could not reconcile subscription invitations',
    )
    expect(internalEventBus.publish).not.toHaveBeenCalled()
    expect(manager.getCachedSubscriptionInvitations()).toBeUndefined()
  })

  it('does not apply a fetched invitation snapshot after the exact session changes', async () => {
    const existing = { uuid: 'existing-invite' } as Invitation
    const replacement = { uuid: 'replacement-invite' } as Invitation
    let release!: (value: { data: { invitations: Invitation[] } }) => void
    subscriptionApiService.listInvites = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const manager = createManager()
    Object.assign(manager, { subscriptionInvitations: [existing] })
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

    const applying = manager.handleInviteRealtimeEvents([subscriptionInviteEvent], context)
    await Promise.resolve()
    current = false
    release({ data: { invitations: [replacement] } })

    await expect(applying).rejects.toThrow('session changed')
    expect(manager.getCachedSubscriptionInvitations()).toEqual([existing])
    expect(internalEventBus.publish).not.toHaveBeenCalled()
  })

  it('fails closed on a realtime invitation after sign-out', async () => {
    sessions.isSignedIn = jest.fn().mockReturnValue(false)

    await expect(createManager().handleInviteRealtimeEvents([subscriptionInviteEvent])).rejects.toThrow(
      'authenticated session',
    )
    expect(internalEventBus.publish).not.toHaveBeenCalled()
  })

  it('should not accept invite if the api fails to do so', async () => {
    subscriptionApiService.acceptInvite = jest.fn().mockReturnValue({ data: { error: { message: 'foobar' } } })

    expect(await createManager().acceptInvitation('1-2-3')).toEqual({ success: false, message: 'foobar' })
  })

  it('should not accept invite if the api throws an error', async () => {
    subscriptionApiService.acceptInvite = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(await createManager().acceptInvitation('1-2-3')).toEqual({
      success: false,
      message: 'Could not accept invitation.',
    })
  })
})
