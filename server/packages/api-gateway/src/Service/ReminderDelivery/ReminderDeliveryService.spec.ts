import { ReminderDeliveryService } from './ReminderDeliveryService'
import { ProviderRegistry } from './Providers/ProviderRegistry'
import { PublishedRemindersStore, DueReminder } from './PublishedRemindersStore'
import { DeliveryConfigStore } from './DeliveryConfigStore'
import { DeliveryConfig, PublishedReminder, ReminderDeliveryProvider } from './Types'

const reminder = (over: Partial<PublishedReminder>): PublishedReminder => ({
  id: over.id ?? 'r1',
  message: over.message ?? 'Take meds',
  dueAtUtc: over.dueAtUtc ?? '2026-06-25T11:00:00.000Z',
  sent: over.sent ?? false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const now = new Date('2026-06-25T12:00:00.000Z')

describe('ReminderDeliveryService.deliverDueReminders', () => {
  let remindersStore: jest.Mocked<Pick<PublishedRemindersStore, 'listAllUnsent' | 'markSent'>>
  let configStore: jest.Mocked<Pick<DeliveryConfigStore, 'getForUser'>>
  let send: jest.Mock

  const makeService = (enabled: boolean, channel = 'telegram'): ReminderDeliveryService => {
    const provider: ReminderDeliveryProvider = { channel: channel as 'telegram', send }
    const registry = new ProviderRegistry([provider])
    return new ReminderDeliveryService(
      enabled,
      remindersStore as unknown as PublishedRemindersStore,
      configStore as unknown as DeliveryConfigStore,
      registry,
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
    remindersStore = { listAllUnsent: jest.fn(), markSent: jest.fn().mockResolvedValue(undefined) }
    configStore = { getForUser: jest.fn() }
  })

  const unsent = (...items: DueReminder[]): void => {
    remindersStore.listAllUnsent.mockResolvedValue(items)
  }

  it('returns an empty summary and does nothing when the feature is disabled', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({}) })
    configStore.getForUser.mockResolvedValue(config())
    const summary = await makeService(false).deliverDueReminders(now)
    expect(summary).toEqual({ scanned: 0, due: 0, sent: 0, failed: 0, skipped: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('delivers a due reminder via the configured channel and marks it sent', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({ id: 'r1' }) })
    configStore.getForUser.mockResolvedValue(config())
    const summary = await makeService(true).deliverDueReminders(now)
    expect(send).toHaveBeenCalledWith('chat-1', expect.stringContaining('Take meds'))
    expect(remindersStore.markSent).toHaveBeenCalledWith('u1', 'r1', true)
    expect(summary).toEqual(expect.objectContaining({ due: 1, sent: 1, failed: 0, skipped: 0 }))
  })

  it('does not deliver a reminder that is not yet due', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({ dueAtUtc: '2026-06-25T12:30:00.000Z' }) })
    configStore.getForUser.mockResolvedValue(config())
    const summary = await makeService(true).deliverDueReminders(now)
    expect(send).not.toHaveBeenCalled()
    expect(summary).toEqual(expect.objectContaining({ due: 0, sent: 0 }))
  })

  it('skips users without an enabled config (and does NOT mark sent)', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({}) })
    configStore.getForUser.mockResolvedValue(config({ enabled: false }))
    const summary = await makeService(true).deliverDueReminders(now)
    expect(send).not.toHaveBeenCalled()
    expect(remindersStore.markSent).not.toHaveBeenCalled()
    expect(summary).toEqual(expect.objectContaining({ due: 1, skipped: 1, sent: 0 }))
  })

  it('records a failure (left unsent) when the provider returns ok:false', async () => {
    send.mockResolvedValue({ ok: false, reason: 'boom' })
    unsent({ userUuid: 'u1', reminder: reminder({ id: 'r1' }) })
    configStore.getForUser.mockResolvedValue(config())
    const summary = await makeService(true).deliverDueReminders(now)
    expect(remindersStore.markSent).toHaveBeenCalledWith('u1', 'r1', false, 'boom')
    expect(summary).toEqual(expect.objectContaining({ failed: 1, sent: 0 }))
  })

  it('honours a per-reminder channel/destination override', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({ channel: 'telegram', destination: 'override-chat' }) })
    configStore.getForUser.mockResolvedValue(config({ destination: 'default-chat' }))
    await makeService(true).deliverDueReminders(now)
    expect(send).toHaveBeenCalledWith('override-chat', expect.any(String))
  })

  it('skips when no adapter is registered for the configured channel', async () => {
    unsent({ userUuid: 'u1', reminder: reminder({}) })
    configStore.getForUser.mockResolvedValue(config({ channel: 'email' }))
    // service registered only a 'telegram' adapter
    const summary = await makeService(true, 'telegram').deliverDueReminders(now)
    expect(send).not.toHaveBeenCalled()
    expect(summary).toEqual(expect.objectContaining({ skipped: 1 }))
  })
})
