import { AdminEmailDeliveryServiceError, EmailRelayUpdate } from './AdminEmailDeliveryService'
import { DefaultAdminEmailDeliveryService } from './DefaultAdminEmailDeliveryService'
import { EmailDeliveryService } from './EmailDeliveryService'
import { EmailDeliveryConfig, EmailRelayView, QueueItemView } from './Types'
import { ServerSettingsResolver } from '../ServerSettings/ServerSettingsResolver'

type SettingsBridge = Pick<
  ServerSettingsResolver,
  'viewEmailRelayConfiguration' | 'resolveEmailRelayConfiguration' | 'applyEmailRelayConfiguration'
>
type DeliveryBridge = Pick<EmailDeliveryService, 'test' | 'listQueue' | 'listLogs' | 'requeue' | 'discard'>

const cursor = (offset: number): string => Buffer.from(String(offset), 'utf8').toString('base64url')

const relayView = (): EmailRelayView => ({
  id: 'smtp-primary',
  name: 'Primary SMTP',
  kind: 'smtp',
  enabled: true,
  priority: 0,
  from: 'Notes <notes@example.com>',
  rateLimit: { max: 0, windowSeconds: 60 },
  credentialsConfigured: true,
  host: 'smtp.example.com',
  port: 587,
  username: 'mailer',
  tlsMode: 'starttls',
})

const internalConfig = (): EmailDeliveryConfig => ({
  relays: [
    {
      id: 'smtp-primary',
      name: 'Primary SMTP',
      kind: 'smtp',
      enabled: true,
      priority: 0,
      from: 'Notes <notes@example.com>',
      rateLimit: { max: 0, windowSeconds: 60 },
      host: 'smtp.example.com',
      port: 587,
      username: 'mailer',
      password: 'stored-secret',
      tlsMode: 'starttls',
    },
  ],
  fallbackPolicy: { mode: 'next-enabled' },
})

const relayUpdate = (): EmailRelayUpdate => ({
  relays: [
    {
      id: 'smtp-primary',
      name: 'Primary SMTP',
      kind: 'smtp',
      enabled: true,
      priority: 0,
      from: 'Notes <notes@example.com>',
      rateLimit: { max: 0, windowSeconds: 60 },
      host: 'smtp.example.com',
      port: 587,
      username: 'mailer',
      tlsMode: 'starttls',
    },
  ],
  fallbackPolicy: { mode: 'next-enabled' },
})

const deadItem = (): QueueItemView => ({
  id: 'job-1',
  state: 'dead',
  source: 'reminder',
  attempt: 3,
  maxAttempts: 3,
  createdAt: 1_786_616_400_000,
  nextAttemptAt: 1_786_616_700_000,
  lastRelayId: 'smtp-primary',
  lastFailureClass: 'authentication',
})

describe('DefaultAdminEmailDeliveryService', () => {
  let settings: jest.Mocked<SettingsBridge>
  let delivery: jest.Mocked<DeliveryBridge>
  let facade: DefaultAdminEmailDeliveryService

  beforeEach(() => {
    settings = {
      viewEmailRelayConfiguration: jest.fn().mockResolvedValue({
        relays: [relayView()],
        fallbackPolicy: { mode: 'next-enabled' },
        configured: true,
      }),
      resolveEmailRelayConfiguration: jest.fn().mockResolvedValue(internalConfig()),
      applyEmailRelayConfiguration: jest.fn().mockResolvedValue({
        relays: [relayView()],
        fallbackPolicy: { mode: 'next-enabled' },
        configured: true,
      }),
    }
    delivery = {
      test: jest.fn().mockResolvedValue({
        accepted: true,
        relayId: 'smtp-primary',
        relayKind: 'smtp',
        outcome: 'sent',
      }),
      listQueue: jest.fn().mockResolvedValue({ items: [] }),
      listLogs: jest.fn().mockResolvedValue({ items: [] }),
      requeue: jest.fn().mockResolvedValue(deadItem()),
      discard: jest.fn().mockResolvedValue('discarded'),
    }
    facade = new DefaultAdminEmailDeliveryService(
      settings as unknown as ServerSettingsResolver,
      delivery as unknown as EmailDeliveryService,
    )
  })

  it('projects the resolver relay view field by field and cannot retain injected credentials or PII', async () => {
    const injected = relayView() as unknown as Record<string, unknown>
    injected.password = 'must-not-survive'
    injected.recipient = 'private@example.com'
    injected.rawProviderResponse = 'private upstream response'
    settings.viewEmailRelayConfiguration.mockResolvedValue({
      relays: [injected as unknown as EmailRelayView],
      fallbackPolicy: { mode: 'next-enabled' },
      configured: true,
    })

    const result = await facade.getRelays()

    expect(result).toEqual({
      relays: [relayView()],
      fallbackPolicy: { mode: 'next-enabled' },
      configured: true,
    })
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('private upstream response')
  })

  it('prevalidates relay writes with existing write-only credentials, then forwards the unchanged update', async () => {
    const update = relayUpdate()

    await expect(facade.putRelays(update)).resolves.toMatchObject({ configured: true })

    expect(settings.resolveEmailRelayConfiguration).toHaveBeenCalledTimes(1)
    expect(settings.applyEmailRelayConfiguration).toHaveBeenCalledWith(update)
    expect(update.relays[0]).not.toHaveProperty('password')
  })

  it('classifies a provider-invalid relay write as bad-request before persistence', async () => {
    const invalid: EmailRelayUpdate = {
      relays: [
        {
          id: 'new-sendgrid',
          name: 'SendGrid',
          kind: 'sendgrid',
          enabled: true,
          priority: 0,
          from: 'notes@example.com',
          rateLimit: { max: 10, windowSeconds: 60 },
        },
      ],
      fallbackPolicy: { mode: 'none' },
    }

    await expect(facade.putRelays(invalid)).rejects.toMatchObject({ code: 'bad-request' })
    expect(settings.applyEmailRelayConfiguration).not.toHaveBeenCalled()
  })

  it('classifies resolver read and write failures as unavailable without retaining their messages', async () => {
    settings.viewEmailRelayConfiguration.mockRejectedValue(new Error('secret settings path'))
    await expect(facade.getRelays()).rejects.toEqual(new AdminEmailDeliveryServiceError('unavailable'))

    settings.resolveEmailRelayConfiguration.mockResolvedValue(internalConfig())
    settings.applyEmailRelayConfiguration.mockRejectedValue(new Error('secret persistence detail'))
    await expect(facade.putRelays(relayUpdate())).rejects.toEqual(new AdminEmailDeliveryServiceError('unavailable'))
  })

  it('delegates the redacted test result and maps thrown provider details to provider-failure', async () => {
    await expect(facade.testDelivery({ recipient: 'operator@example.com', relayId: 'smtp-primary' })).resolves.toEqual({
      accepted: true,
      relayId: 'smtp-primary',
      relayKind: 'smtp',
      outcome: 'sent',
    })
    expect(delivery.test).toHaveBeenCalledWith('operator@example.com', 'smtp-primary')

    delivery.test.mockRejectedValue(new Error('550 private provider response'))
    await expect(facade.testDelivery({ recipient: 'operator@example.com' })).rejects.toEqual(
      new AdminEmailDeliveryServiceError('provider-failure'),
    )
  })

  it('forwards queue pagination and returns only the documented metadata fields', async () => {
    const injected = deadItem() as unknown as Record<string, unknown>
    injected.recipient = 'private@example.com'
    injected.body = 'private body'
    delivery.listQueue.mockResolvedValue({ items: [injected as unknown as QueueItemView], nextCursor: cursor(25) })

    const result = await facade.listQueue({ state: 'dead', limit: 25, cursor: cursor(0) })

    expect(delivery.listQueue).toHaveBeenCalledWith('dead', 25, cursor(0))
    expect(result).toEqual({ items: [deadItem()], nextCursor: cursor(25) })
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('private body')
  })

  it('rejects a forged queue cursor as bad-request before reaching the runtime', async () => {
    await expect(facade.listQueue({ state: 'dead', limit: 25, cursor: 'not-a-runtime-cursor' })).rejects.toMatchObject({
      code: 'bad-request',
    })
    expect(delivery.listQueue).not.toHaveBeenCalled()
  })

  it('classifies an invalid cursor emitted by the runtime as unavailable rather than blaming the request', async () => {
    delivery.listQueue.mockResolvedValue({ items: [], nextCursor: 'invalid-runtime-cursor' })

    await expect(facade.listQueue({ state: 'dead', limit: 25 })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('forwards log filters and strips runtime-injected message content', async () => {
    delivery.listLogs.mockResolvedValue({
      items: [
        {
          id: 'log-1',
          jobId: 'job-1',
          relayId: 'smtp-primary',
          relayKind: 'smtp',
          attempt: 3,
          outcome: 'rejected',
          failureClass: 'authentication',
          providerCode: 'AUTH',
          httpStatus: 401,
          durationMs: 42,
          createdAt: 1_786_616_460_000,
          recipient: 'private@example.com',
          body: 'private body',
          rawProviderResponse: 'private upstream response',
        } as never,
      ],
      nextCursor: cursor(20),
    })

    const result = await facade.listLogs({
      limit: 20,
      cursor: cursor(0),
      relayId: 'smtp-primary',
      outcome: 'rejected',
    })

    expect(delivery.listLogs).toHaveBeenCalledWith(20, cursor(0), {
      relayId: 'smtp-primary',
      outcome: 'rejected',
    })
    expect(result.items[0]).toEqual({
      id: 'log-1',
      jobId: 'job-1',
      relayId: 'smtp-primary',
      relayKind: 'smtp',
      attempt: 3,
      outcome: 'rejected',
      failureClass: 'authentication',
      providerCode: 'AUTH',
      httpStatus: 401,
      durationMs: 42,
      createdAt: 1_786_616_460_000,
    })
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('private body')
    expect(JSON.stringify(result)).not.toContain('private upstream response')
  })

  it('returns a successful requeue projection without a classification scan', async () => {
    await expect(facade.retryQueueItem('job-1')).resolves.toEqual(deadItem())
    expect(delivery.requeue).toHaveBeenCalledWith('job-1')
    expect(delivery.listQueue).not.toHaveBeenCalled()
  })

  it('maps a failed requeue of a leased item to conflict', async () => {
    delivery.requeue.mockResolvedValue(null)
    delivery.listQueue.mockImplementation(async (state) => ({
      items: state === 'leased' ? [{ ...deadItem(), state: 'leased', leaseExpiresAt: 1_786_616_700_000 }] : [],
    }))

    await expect(facade.retryQueueItem('job-1')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps a failed requeue with no visible queue record to not-found', async () => {
    delivery.requeue.mockResolvedValue(null)
    delivery.listQueue.mockResolvedValue({ items: [] })

    await expect(facade.retryQueueItem('missing')).rejects.toMatchObject({ code: 'not-found' })
    expect(delivery.listQueue).toHaveBeenCalledTimes(3)
  })

  it('refuses to discard an in-flight leased item', async () => {
    delivery.discard.mockResolvedValue('leased')

    await expect(facade.discardQueueItem('job-1')).rejects.toMatchObject({ code: 'conflict' })
    expect(delivery.discard).toHaveBeenCalledWith('job-1')
    expect(delivery.listQueue).not.toHaveBeenCalled()
  })

  it('maps the atomic discard result without a race-prone classification scan', async () => {
    await expect(facade.discardQueueItem('job-1')).resolves.toBeUndefined()
    expect(delivery.discard).toHaveBeenCalledWith('job-1')
    expect(delivery.listQueue).not.toHaveBeenCalled()

    delivery.discard.mockResolvedValue('not-found')
    await expect(facade.discardQueueItem('missing')).rejects.toMatchObject({ code: 'not-found' })
  })
})
