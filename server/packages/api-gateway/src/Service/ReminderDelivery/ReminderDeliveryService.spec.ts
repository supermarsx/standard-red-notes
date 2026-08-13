import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ReminderDeliveryService } from './ReminderDeliveryService'
import { ProviderRegistry } from './Providers/ProviderRegistry'
import { ClaimedReminder, PublishedRemindersStore } from './PublishedRemindersStore'
import { DeliveryConfigStore } from './DeliveryConfigStore'
import { DeliveryConfig, PublishedReminder, ReminderDeliveryProvider } from './Types'

const NOW = Date.parse('2026-06-25T12:00:00.000Z')
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLAIM_A = '11111111-1111-4111-8111-111111111111'

const reminder = (over: Partial<PublishedReminder> = {}): PublishedReminder => ({
  id: 'r1',
  message: 'Take meds',
  dueAtUtc: '2026-06-25T11:00:00.000Z',
  sent: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const claimedReminder = (over: Partial<PublishedReminder> = {}): ClaimedReminder => ({
  userUuid: 'u1',
  reminder: reminder(over),
  claim: {
    id: CLAIM_A,
    owner: OWNER_A,
    claimedAt: NOW,
    leaseExpiresAt: NOW + 1_000,
  },
})

describe('ReminderDeliveryService.deliverDueReminders', () => {
  let remindersStore: jest.Mocked<
    Pick<PublishedRemindersStore, 'claimDue' | 'markClaimSucceeded' | 'scheduleClaimRetry'>
  >
  let configStore: jest.Mocked<Pick<DeliveryConfigStore, 'getForUser'>>
  let send: jest.Mock

  const makeService = (enabled: boolean, channel: 'telegram' | 'email' = 'telegram'): ReminderDeliveryService => {
    const provider: ReminderDeliveryProvider = { channel, send }
    const registry = new ProviderRegistry([provider])
    return new ReminderDeliveryService(
      enabled,
      remindersStore as unknown as PublishedRemindersStore,
      configStore as unknown as DeliveryConfigStore,
      registry,
      { ownerId: OWNER_A, clock: () => NOW },
    )
  }

  const config = (over: Partial<DeliveryConfig> = {}): DeliveryConfig => ({
    channel: 'telegram',
    destination: 'chat-1',
    enabled: true,
    ...over,
  })

  beforeEach(() => {
    send = jest.fn().mockResolvedValue({ ok: true })
    remindersStore = {
      claimDue: jest.fn(),
      markClaimSucceeded: jest.fn().mockResolvedValue(true),
      scheduleClaimRetry: jest.fn().mockResolvedValue(true),
    }
    configStore = { getForUser: jest.fn() }
  })

  const claimed = (...items: ClaimedReminder[]): void => {
    remindersStore.claimDue.mockResolvedValue(items)
  }

  it('returns an empty summary without claiming work when the feature is disabled', async () => {
    configStore.getForUser.mockResolvedValue(config())
    const summary = await makeService(false).deliverDueReminders(new Date(NOW))
    expect(summary).toEqual({ scanned: 0, due: 0, sent: 0, failed: 0, skipped: 0 })
    expect(remindersStore.claimDue).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('delivers a claimed reminder and conditionally marks the live claim successful', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockResolvedValue(config())

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(remindersStore.claimDue).toHaveBeenCalledWith(OWNER_A, NOW)
    expect(send).toHaveBeenCalledWith('chat-1', expect.stringContaining('Take meds'))
    expect(remindersStore.markClaimSucceeded).toHaveBeenCalledWith('u1', 'r1', due.claim, NOW)
    expect(summary).toEqual({ scanned: 1, due: 1, sent: 1, failed: 0, skipped: 0 })
  })

  it('does not report success when the claim expired before completion', async () => {
    claimed(claimedReminder())
    configStore.getForUser.mockResolvedValue(config())
    remindersStore.markClaimSucceeded.mockResolvedValue(false)

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(send).toHaveBeenCalledTimes(1)
    expect(summary).toEqual({ scanned: 1, due: 1, sent: 0, failed: 0, skipped: 1 })
  })

  it('schedules persisted backoff when the user has not enabled delivery', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockResolvedValue(config({ enabled: false }))

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(send).not.toHaveBeenCalled()
    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
      'u1',
      'r1',
      due.claim,
      'Reminder delivery is disabled for this user.',
      NOW,
    )
    expect(summary).toEqual(expect.objectContaining({ due: 1, skipped: 1, sent: 0 }))
  })

  it('records a provider result failure for retry', async () => {
    const due = claimedReminder()
    send.mockResolvedValue({ ok: false, reason: 'boom' })
    claimed(due)
    configStore.getForUser.mockResolvedValue(config())

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith('u1', 'r1', due.claim, 'boom', NOW)
    expect(summary).toEqual(expect.objectContaining({ failed: 1, sent: 0 }))
  })

  it('catches a provider throw, persists retry state, and continues with later reminders', async () => {
    const first = claimedReminder({ id: 'r1' })
    const second = {
      ...claimedReminder({ id: 'r2', message: 'Second' }),
      claim: { ...claimedReminder().claim, id: '22222222-2222-4222-8222-222222222222' },
    }
    claimed(first, second)
    configStore.getForUser.mockResolvedValue(config())
    send.mockRejectedValueOnce(new Error('provider exploded')).mockResolvedValueOnce({ ok: true })

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
      'u1',
      'r1',
      first.claim,
      expect.objectContaining({ message: 'provider exploded' }),
      NOW,
    )
    expect(remindersStore.markClaimSucceeded).toHaveBeenCalledWith('u1', 'r2', second.claim, NOW)
    expect(summary).toEqual({ scanned: 2, due: 2, sent: 1, failed: 1, skipped: 0 })
  })

  it.each([undefined, null, {}, { ok: 'yes' }, { ok: false, reason: 42 }])(
    'turns malformed provider result %p into a retry and continues the batch',
    async (invalidResult) => {
      const first = claimedReminder({ id: 'r1' })
      const second = {
        ...claimedReminder({ id: 'r2', message: 'Second' }),
        claim: { ...claimedReminder().claim, id: '22222222-2222-4222-8222-222222222222' },
      }
      claimed(first, second)
      configStore.getForUser.mockResolvedValue(config())
      send.mockResolvedValueOnce(invalidResult).mockResolvedValueOnce({ ok: true })

      const summary = await makeService(true).deliverDueReminders(new Date(NOW))

      expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
        'u1',
        'r1',
        first.claim,
        'The reminder delivery provider returned an invalid result.',
        NOW,
      )
      expect(remindersStore.markClaimSucceeded).toHaveBeenCalledWith('u1', 'r2', second.claim, NOW)
      expect(summary).toEqual({ scanned: 2, due: 2, sent: 1, failed: 1, skipped: 0 })
    },
  )

  it('records a configuration-store throw and continues without calling the provider', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockRejectedValue(new Error('config unavailable'))

    const summary = await makeService(true).deliverDueReminders(new Date(NOW))

    expect(send).not.toHaveBeenCalled()
    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
      'u1',
      'r1',
      due.claim,
      expect.objectContaining({ message: 'config unavailable' }),
      NOW,
    )
    expect(summary.failed).toBe(1)
  })

  it('honours a per-reminder channel and destination override', async () => {
    claimed(claimedReminder({ channel: 'telegram', destination: 'override-chat' }))
    configStore.getForUser.mockResolvedValue(config({ destination: 'default-chat' }))

    await makeService(true).deliverDueReminders(new Date(NOW))

    expect(send).toHaveBeenCalledWith('override-chat', expect.any(String))
  })

  it('gives email providers a deterministic opaque delivery identity', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockResolvedValue(config({ channel: 'email', destination: 'person@example.com' }))

    await makeService(true, 'email').deliverDueReminders(new Date(NOW))

    expect(send).toHaveBeenCalledWith(
      'person@example.com',
      expect.stringContaining('Take meds'),
      expect.objectContaining({ deliveryId: expect.stringMatching(/^published-reminder-[a-f0-9]{64}$/) }),
    )
  })

  it('keeps a durably queued reminder unsent until the provider receipt is accepted', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockResolvedValue(config({ channel: 'email', destination: 'person@example.com' }))
    send.mockResolvedValue({ ok: false, pending: true, reason: 'awaiting provider acceptance' })

    const summary = await makeService(true, 'email').deliverDueReminders(new Date(NOW))

    expect(remindersStore.markClaimSucceeded).not.toHaveBeenCalled()
    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
      'u1',
      'r1',
      due.claim,
      'awaiting provider acceptance',
      NOW,
    )
    expect(summary).toEqual({ scanned: 1, due: 1, sent: 0, failed: 0, skipped: 1 })
  })

  it('schedules a retry when no adapter is registered for the effective channel', async () => {
    const due = claimedReminder()
    claimed(due)
    configStore.getForUser.mockResolvedValue(config({ channel: 'email' }))

    const summary = await makeService(true, 'telegram').deliverDueReminders(new Date(NOW))

    expect(send).not.toHaveBeenCalled()
    expect(remindersStore.scheduleClaimRetry).toHaveBeenCalledWith(
      'u1',
      'r1',
      due.claim,
      'No reminder delivery provider is registered for email.',
      NOW,
    )
    expect(summary).toEqual(expect.objectContaining({ skipped: 1 }))
  })

  it('loads one configuration per user for a claimed batch', async () => {
    claimed(claimedReminder({ id: 'r1' }), {
      ...claimedReminder({ id: 'r2' }),
      claim: { ...claimedReminder().claim, id: '22222222-2222-4222-8222-222222222222' },
    })
    configStore.getForUser.mockResolvedValue(config())

    await makeService(true).deliverDueReminders(new Date(NOW))

    expect(configStore.getForUser).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('ReminderDeliveryService multi-instance delivery', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-reminder-delivery-race-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('sends a due occurrence at most once while a cross-instance claim lease is live', async () => {
    const reminderPath = path.join(dir, 'published-reminders.json')
    const configPath = path.join(dir, 'delivery-config.json')
    let claimSequence = 0
    const randomId = (): string => `00000000-0000-4000-8000-${String(++claimSequence).padStart(12, '0')}`
    const storeOptions = {
      clock: () => NOW,
      randomId,
      claimLeaseMs: 1_000,
    }
    const firstStore = new PublishedRemindersStore(reminderPath, storeOptions)
    const secondStore = new PublishedRemindersStore(reminderPath, storeOptions)
    const firstConfig = new DeliveryConfigStore(configPath)
    const secondConfig = new DeliveryConfigStore(configPath)
    await firstStore.publish('u1', {
      id: 'r1',
      message: 'one side effect',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })
    await firstConfig.setForUser('u1', {
      channel: 'telegram',
      destination: 'chat-1',
      enabled: true,
    })

    const send = jest.fn().mockResolvedValue({ ok: true })
    const registry = new ProviderRegistry([{ channel: 'telegram', send }])
    const first = new ReminderDeliveryService(true, firstStore, firstConfig, registry, {
      ownerId: OWNER_A,
      clock: () => NOW,
    })
    const second = new ReminderDeliveryService(true, secondStore, secondConfig, registry, {
      ownerId: OWNER_B,
      clock: () => NOW,
    })

    const summaries = await Promise.all([first.deliverDueReminders(), second.deliverDueReminders()])

    expect(send).toHaveBeenCalledTimes(1)
    expect(summaries.reduce((sum, summary) => sum + summary.sent, 0)).toBe(1)
    expect((await firstStore.getForUser('u1', 'r1'))?.sent).toBe(true)
  })
})

describe('ReminderDeliveryService durable email cancellation', () => {
  let dir: string
  let store: PublishedRemindersStore
  let configStore: DeliveryConfigStore
  let cancel: jest.Mock
  let service: ReminderDeliveryService

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-reminder-cancel-'))
    store = new PublishedRemindersStore(path.join(dir, 'published-reminders.json'), { clock: () => NOW })
    configStore = new DeliveryConfigStore(path.join(dir, 'delivery-config.json'))
    await configStore.setForUser('u1', { channel: 'email', destination: 'old@example.com', enabled: true })
    cancel = jest.fn().mockResolvedValue({ ok: true })
    service = new ReminderDeliveryService(
      true,
      store,
      configStore,
      new ProviderRegistry([{ channel: 'email', send: jest.fn(), cancel }]),
      { ownerId: OWNER_A, clock: () => NOW },
    )
    await service.publish('u1', {
      id: 'r1',
      message: 'Original private reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('persists queue cancellation before unpublishing a pending email', async () => {
    await expect(service.unpublish('u1', 'r1')).resolves.toBe(true)

    expect(cancel).toHaveBeenCalledWith({ deliveryId: expect.stringMatching(/^published-reminder-[a-f0-9]{64}$/) })
    await expect(store.getForUser('u1', 'r1')).resolves.toBeNull()
  })

  it('cancels the old occurrence before publishing an edited reminder', async () => {
    await service.publish('u1', {
      id: 'r1',
      message: 'Edited private reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })

    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(store.getForUser('u1', 'r1')).resolves.toMatchObject({ message: 'Edited private reminder' })
  })

  it('cancels pending occurrences before disabling email delivery', async () => {
    await service.setConfig('u1', { channel: 'email', destination: 'old@example.com', enabled: false })
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(store.getForUser('u1', 'r1')).resolves.toBeNull()
  })

  it('cancels pending occurrences before changing the inherited email destination', async () => {
    await service.setConfig('u1', { channel: 'email', destination: 'new@example.com', enabled: true })
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(store.getForUser('u1', 'r1')).resolves.toBeNull()
  })

  it('does not cancel an explicit override whose effective delivery is unchanged', async () => {
    await store.unpublish('u1', 'r1')
    await service.publish('u1', {
      id: 'explicit',
      message: 'Explicit destination',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
      channel: 'email',
      destination: 'fixed@example.com',
    })

    await service.setConfig('u1', { channel: 'email', destination: 'new@example.com', enabled: true })

    expect(cancel).not.toHaveBeenCalled()
    await expect(store.getForUser('u1', 'explicit')).resolves.toMatchObject({ destination: 'fixed@example.com' })
  })

  it('does not self-cancel a representation-only inherited-to-explicit edit', async () => {
    const before = await store.getForUser('u1', 'r1')
    await service.publish('u1', {
      id: 'r1',
      message: 'Original private reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
      channel: 'email',
      destination: 'old@example.com',
    })

    expect(cancel).not.toHaveBeenCalled()
    expect((await store.getForUser('u1', 'r1'))?.deliveryRevision).toBe(before?.deliveryRevision)
  })

  it('uses a new durable identity after disable and explicit re-publication', async () => {
    const firstRevision = (await store.getForUser('u1', 'r1'))?.deliveryRevision
    await service.setConfig('u1', { channel: 'email', destination: 'old@example.com', enabled: false })
    await configStore.setForUser('u1', { channel: 'email', destination: 'old@example.com', enabled: true })
    const republished = await service.publish('u1', {
      id: 'r1',
      message: 'Original private reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })

    expect(republished.deliveryRevision).not.toBe(firstRevision)
  })

  it('fails closed without deleting or replacing state when cancellation is in flight', async () => {
    cancel.mockResolvedValue({ ok: false, inFlight: true, reason: 'already in flight' })

    await expect(service.unpublish('u1', 'r1')).rejects.toThrow('already in flight')
    await expect(store.getForUser('u1', 'r1')).resolves.toMatchObject({ message: 'Original private reminder' })
  })

  it('conflicts and preserves the original reminder when an edited occurrence was provider accepted', async () => {
    const before = await store.getForUser('u1', 'r1')
    cancel.mockResolvedValue({ ok: true, providerAccepted: true })

    await expect(
      service.publish('u1', {
        id: 'r1',
        message: 'Edited private reminder',
        dueAtUtc: '2026-06-25T11:00:00.000Z',
      }),
    ).rejects.toThrow('already accepted')

    await expect(store.getForUser('u1', 'r1')).resolves.toEqual(before)
  })

  it('conflicts and preserves the reminder when unpublish finds provider acceptance', async () => {
    const before = await store.getForUser('u1', 'r1')
    cancel.mockResolvedValue({ ok: true, providerAccepted: true })

    await expect(service.unpublish('u1', 'r1')).rejects.toThrow('already accepted')

    await expect(store.getForUser('u1', 'r1')).resolves.toEqual(before)
  })

  it('conflicts and preserves reminder and config state when a config mutation finds provider acceptance', async () => {
    const reminderBefore = await store.getForUser('u1', 'r1')
    const configBefore = await configStore.getForUser('u1')
    cancel.mockResolvedValue({ ok: true, providerAccepted: true })

    await expect(
      service.setConfig('u1', { channel: 'email', destination: 'new@example.com', enabled: true }),
    ).rejects.toThrow('already accepted')

    await expect(store.getForUser('u1', 'r1')).resolves.toEqual(reminderBefore)
    await expect(configStore.getForUser('u1')).resolves.toEqual(configBefore)
  })

  it('authoritatively opts out after provider acceptance and reports the irreversible dispatch', async () => {
    cancel.mockResolvedValue({ ok: true, providerAccepted: true })

    await expect(service.optOut('u1')).resolves.toEqual({ alreadyDispatched: true })

    await expect(store.listForUser('u1')).resolves.toEqual([])
    await expect(configStore.getForUser('u1')).resolves.toBeNull()
  })

  it('erases pending and delivered plaintext plus the destination on account opt-out', async () => {
    const [claim] = await store.claimDue(OWNER_A, NOW)
    await store.markClaimSucceeded('u1', 'r1', claim.claim, NOW)
    await service.publish('u1', {
      id: 'pending',
      message: 'Pending private reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })

    await service.optOut('u1')

    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(store.listForUser('u1')).resolves.toEqual([])
    await expect(configStore.getForUser('u1')).resolves.toBeNull()
  })

  it('allows idle direct-SMTP reminders to be removed but refuses an active claim', async () => {
    const direct = new ReminderDeliveryService(
      true,
      store,
      configStore,
      new ProviderRegistry([{ channel: 'email', send: jest.fn() }]),
      { ownerId: OWNER_A, clock: () => NOW },
    )
    await expect(direct.unpublish('u1', 'r1')).resolves.toBe(true)

    await direct.publish('u1', {
      id: 'claimed',
      message: 'Direct SMTP reminder',
      dueAtUtc: '2026-06-25T11:00:00.000Z',
    })
    await store.claimDue(OWNER_A, NOW)
    await expect(direct.unpublish('u1', 'claimed')).rejects.toThrow('already in flight')
    await expect(store.getForUser('u1', 'claimed')).resolves.not.toBeNull()
  })
})
