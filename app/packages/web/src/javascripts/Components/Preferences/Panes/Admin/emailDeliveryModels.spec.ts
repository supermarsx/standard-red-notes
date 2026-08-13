import {
  controlPlaneError,
  decodeLogsResponse,
  decodeQueueResponse,
  decodeRelaysResponse,
  normalizeRelayPriorities,
  relayViewToDraft,
  serializeRelayDraft,
} from './emailDeliveryModels'

const smtpView = {
  id: 'smtp-primary',
  name: 'Primary SMTP',
  kind: 'smtp' as const,
  enabled: true,
  priority: 9,
  from: 'Notes <notes@example.com>',
  rateLimit: { max: 20, windowSeconds: 60 },
  host: 'smtp.example.com',
  port: 587,
  username: 'mailer',
  tlsMode: 'starttls' as const,
  credentialsConfigured: true,
}

describe('email delivery control-plane models', () => {
  it('decodes only documented public relay fields and never retains unexpected secrets or message data', () => {
    const decoded = decodeRelaysResponse({
      relays: [
        {
          ...smtpView,
          password: 'must-never-survive',
          recipient: 'private@example.com',
          subject: 'private subject',
          body: 'private body',
          rawProviderResponse: 'raw provider text',
        },
      ],
      fallbackPolicy: { mode: 'next-enabled' },
      configured: true,
    })

    expect(decoded).toEqual({
      relays: [smtpView],
      fallbackPolicy: { mode: 'next-enabled' },
      configured: true,
    })
    const serialized = JSON.stringify(decoded)
    expect(serialized).not.toContain('must-never-survive')
    expect(serialized).not.toContain('private@example.com')
    expect(serialized).not.toContain('private subject')
    expect(serialized).not.toContain('private body')
    expect(serialized).not.toContain('raw provider text')
  })

  it('omits write-only credentials on ordinary saves and sends null only after an explicit clear', () => {
    const draft = relayViewToDraft(smtpView)
    const preserved = serializeRelayDraft(draft)
    expect(preserved).not.toHaveProperty('password')

    const cleared = serializeRelayDraft({ ...draft, clearCredentials: true })
    expect(cleared).toHaveProperty('password', null)

    const replaced = serializeRelayDraft({ ...draft, password: 'new-secret' })
    expect(replaced).toHaveProperty('password', 'new-secret')
  })

  it('normalizes priority ordering without changing relay identities', () => {
    const first = relayViewToDraft(smtpView)
    const second = { ...first, id: 'smtp-secondary', name: 'Secondary', priority: 2 }
    expect(normalizeRelayPriorities([second, first]).map(({ id, priority }) => ({ id, priority }))).toEqual([
      { id: 'smtp-secondary', priority: 1 },
      { id: 'smtp-primary', priority: 2 },
    ])
  })

  it('decodes queue and log metadata without retaining injected content fields', () => {
    const queue = decodeQueueResponse({
      items: [
        {
          id: 'job-1',
          state: 'dead',
          source: 'reminder',
          attempt: 3,
          maxAttempts: 3,
          createdAt: '2026-08-13T10:00:00.000Z',
          lastFailureClass: 'authentication',
          recipient: 'private@example.com',
          subject: 'private subject',
        },
      ],
    })
    const logs = decodeLogsResponse({
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
          createdAt: '2026-08-13T10:01:00.000Z',
          body: 'private body',
          rawProviderResponse: 'raw upstream detail',
        },
      ],
    })

    expect(JSON.stringify(queue)).not.toContain('private@example.com')
    expect(JSON.stringify(queue)).not.toContain('private subject')
    expect(JSON.stringify(logs)).not.toContain('private body')
    expect(JSON.stringify(logs)).not.toContain('raw upstream detail')
    expect(logs?.items[0]).toMatchObject({ outcome: 'rejected', providerCode: 'AUTH', httpStatus: 401 })
  })

  it('maps HTTP failures to redacted operator guidance without consuming an upstream error body', () => {
    expect(controlPlaneError(502, 'Send test email')).toBe(
      'Send test email failed at the provider boundary. Check the redacted delivery log.',
    )
    expect(controlPlaneError(409, 'Retry delivery')).toContain('currently leased')
  })
})
