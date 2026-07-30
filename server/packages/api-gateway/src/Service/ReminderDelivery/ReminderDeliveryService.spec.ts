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
