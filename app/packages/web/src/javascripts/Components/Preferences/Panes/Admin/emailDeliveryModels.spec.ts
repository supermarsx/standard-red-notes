import {
  controlPlaneError,
  decodeLogsResponse,
  decodeQueueResponse,
  decodeRelaysResponse,
  normalizeRelayPriorities,
  relayIsConformant,
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

  it('accepts a zero maximum as the documented disabled rate-limit mode', () => {
    const draft = relayViewToDraft({ ...smtpView, rateLimit: { max: 0, windowSeconds: 60 } })

    expect(relayIsConformant(draft)).toBe(true)
  })

  it('accepts the AWS default credential chain and disabled credentialless API relays', () => {
    const aws = {
      ...relayViewToDraft(smtpView),
      id: 'ses-primary',
      kind: 'aws-ses' as const,
      region: 'eu-west-1',
      credentialsConfigured: false,
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
    }
    const disabledSendGrid = {
      ...aws,
      id: 'sendgrid-standby',
      kind: 'sendgrid' as const,
      enabled: false,
      apiKey: '',
    }

    expect(relayIsConformant(aws)).toBe(true)
    expect(relayIsConformant(disabledSendGrid)).toBe(true)
  })

  it('allows unauthenticated SMTP but requires an explicit clear when removing stored authentication', () => {
    const unauthenticated = relayViewToDraft({
      ...smtpView,
      username: undefined,
      credentialsConfigured: false,
    })
    const removingStoredAuthentication = { ...relayViewToDraft(smtpView), username: '' }

    expect(relayIsConformant(unauthenticated)).toBe(true)
    expect(relayIsConformant(removingStoredAuthentication)).toBe(false)
    expect(relayIsConformant({ ...removingStoredAuthentication, clearCredentials: true })).toBe(true)
  })

  it('requires paired credential rotation in the conformity preview', () => {
    const smtpUsernameOnly = { ...relayViewToDraft(smtpView), username: 'replacement-user' }
    const ses = {
      ...relayViewToDraft(smtpView),
      kind: 'aws-ses' as const,
      region: 'eu-west-1',
      credentialsConfigured: true,
      accessKeyId: 'replacement-access',
    }

    expect(relayIsConformant(smtpUsernameOnly)).toBe(false)
    expect(relayIsConformant({ ...smtpUsernameOnly, password: 'replacement-secret' })).toBe(true)
    expect(relayIsConformant(ses)).toBe(false)
    expect(relayIsConformant({ ...ses, secretAccessKey: 'replacement-secret' })).toBe(true)
  })

  it('keeps sender and provider-domain conformity aligned with the server boundary', () => {
    const smtp = relayViewToDraft(smtpView)
    expect(relayIsConformant({ ...smtp, from: 'Notes <notes@example.com>' })).toBe(true)
    expect(relayIsConformant({ ...smtp, from: 'notes@example.com' })).toBe(true)
    expect(relayIsConformant({ ...smtp, from: '@' })).toBe(false)
    expect(relayIsConformant({ ...smtp, from: 'foo,bar@example.com' })).toBe(false)
    expect(relayIsConformant({ ...smtp, from: 'foo@example..com' })).toBe(false)
    expect(relayIsConformant({ ...smtp, from: 'foo@-example.com' })).toBe(false)
    expect(relayIsConformant({ ...smtp, from: '<notes@example.com>' })).toBe(false)
    expect(relayIsConformant({ ...smtp, from: 'Notes <notes@example.com> trailing' })).toBe(false)

    const mailgun = {
      ...smtp,
      kind: 'mailgun' as const,
      domain: 'mg.example.com',
      apiKey: 'secret',
      credentialsConfigured: false,
    }
    expect(relayIsConformant(mailgun)).toBe(true)
    expect(relayIsConformant({ ...mailgun, domain: '-invalid.example.com' })).toBe(false)
    expect(relayIsConformant({ ...mailgun, domain: 'invalid..example.com' })).toBe(false)
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

  it('accepts the distinct published-reminder queue attribution', () => {
    expect(
      decodeQueueResponse({
        items: [
          {
            id: 'published-job',
            state: 'ready',
            source: 'published-reminder',
            attempt: 0,
            maxAttempts: 5,
            createdAt: '2026-08-13T10:00:00.000Z',
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'published-job', source: 'published-reminder' })],
      }),
    )
  })

  it('maps HTTP failures to redacted operator guidance without consuming an upstream error body', () => {
    expect(controlPlaneError(502, 'Send test email')).toBe(
      'Send test email failed at the provider boundary. Check the redacted delivery log.',
    )
    expect(controlPlaneError(409, 'Retry delivery')).toContain('currently leased')
  })
})
