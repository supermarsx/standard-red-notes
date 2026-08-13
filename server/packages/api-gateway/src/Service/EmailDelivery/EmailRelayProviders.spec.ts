import { DefaultEmailRelayFactory } from './EmailRelayProviders'
import { mergeRelayConfiguration, relayConfigurationView } from './RelayConfiguration'
import { EmailDeliveryConfig, EmailRelayProfile, toRelayView, validateRelayProfile } from './Types'

const common = {
  name: 'Primary',
  enabled: true,
  priority: 10,
  from: 'Standard Red Notes <sender@example.com>',
  rateLimit: { max: 100, windowSeconds: 60 },
}

describe('HTTP email relay providers', () => {
  it('sends a bounded SendGrid request and classifies acceptance without exposing its key', async () => {
    const fetcher = jest.fn(async () => new Response('', { status: 202 }))
    const profile: EmailRelayProfile = { ...common, id: 'sendgrid-main', kind: 'sendgrid', apiKey: 'secret-api-key' }
    const relay = new DefaultEmailRelayFactory(fetcher).create(profile)

    const result = await relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })

    expect(result).toEqual({ outcome: 'sent', providerCode: 'HTTP_202', httpStatus: 202 })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    )
    const init = fetcher.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-api-key')
    expect(String(init.body)).toContain('recipient@example.com')
    expect(JSON.stringify(result)).not.toContain('secret-api-key')
    expect(JSON.stringify(result)).not.toContain('recipient@example.com')
  })

  it.each([
    [429, 'transient-failure'],
    [503, 'transient-failure'],
    [400, 'permanent-failure'],
  ] as const)('classifies SendGrid HTTP %s without reading the provider body', async (status, outcome) => {
    const response = new Response('could contain a credential or recipient', { status })
    const textSpy = jest.spyOn(response, 'text')
    const fetcher = jest.fn(async () => response)
    const relay = new DefaultEmailRelayFactory(fetcher).create({
      ...common,
      id: 'sendgrid-main',
      kind: 'sendgrid',
      apiKey: 'secret-api-key',
    })

    await expect(relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })).resolves.toEqual(
      expect.objectContaining({ outcome, providerCode: `HTTP_${status}`, httpStatus: status }),
    )
    expect(textSpy).not.toHaveBeenCalled()
  })

  it('uses only an allowlisted Mailgun origin and returns a sanitized network failure', async () => {
    const fetcher = jest.fn(async () => {
      const error = new Error('request with key secret-mailgun failed') as Error & { code: string }
      error.code = 'ECONNRESET'
      throw error
    })
    const relay = new DefaultEmailRelayFactory(fetcher).create({
      ...common,
      id: 'mailgun-eu',
      kind: 'mailgun',
      domain: 'mg.example.com',
      baseUrl: 'https://api.eu.mailgun.net',
      apiKey: 'secret-mailgun',
    })

    const result = await relay.send({ to: 'recipient@example.com', subject: 'Subject', html: '<b>Body</b>' })

    expect(fetcher.mock.calls[0][0]).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages')
    expect(result).toEqual({ outcome: 'transient-failure', failureClass: 'network', providerCode: 'ECONNRESET' })
    expect(JSON.stringify(result)).not.toContain('secret-mailgun')
  })
})

describe('email relay configuration', () => {
  it('preserves omitted write-only keys and never includes them in a relay view', () => {
    const existing: EmailDeliveryConfig = {
      relays: [{ ...common, id: 'sendgrid-main', kind: 'sendgrid', apiKey: 'stored-secret' }],
      fallbackPolicy: { mode: 'none' },
    }

    const merged = mergeRelayConfiguration(
      {
        relays: [{ ...common, id: 'sendgrid-main', kind: 'sendgrid' }],
        fallbackPolicy: { mode: 'next-enabled' },
      },
      existing,
    )
    const view = relayConfigurationView(merged)

    expect(merged.relays[0]).toEqual(expect.objectContaining({ apiKey: 'stored-secret' }))
    expect(view.relays[0]).toEqual(expect.objectContaining({ credentialsConfigured: true }))
    expect(JSON.stringify(view)).not.toContain('stored-secret')
    expect(JSON.stringify(view)).not.toContain('apiKey')
  })

  it('allows an operator to clear a disabled profile secret explicitly', () => {
    const existing: EmailDeliveryConfig = {
      relays: [{ ...common, id: 'sendgrid-main', kind: 'sendgrid', apiKey: 'stored-secret' }],
      fallbackPolicy: { mode: 'none' },
    }

    const merged = mergeRelayConfiguration(
      {
        relays: [{ ...common, enabled: false, id: 'sendgrid-main', kind: 'sendgrid', apiKey: null }],
        fallbackPolicy: { mode: 'none' },
      },
      existing,
    )

    expect(merged.relays[0]).not.toHaveProperty('apiKey')
    expect(toRelayView(merged.relays[0]).credentialsConfigured).toBe(false)
  })

  it('rejects duplicate ids, unsafe Mailgun origins, and incomplete active credentials', () => {
    expect(() =>
      mergeRelayConfiguration(
        {
          relays: [
            { ...common, id: 'duplicate', kind: 'sendgrid', apiKey: 'one' },
            { ...common, id: 'duplicate', kind: 'sendgrid', apiKey: 'two' },
          ],
          fallbackPolicy: { mode: 'none' },
        },
        undefined,
      ),
    ).toThrow('unique')
    expect(() =>
      validateRelayProfile({
        ...common,
        id: 'mailgun',
        kind: 'mailgun',
        domain: 'mg.example.com',
        baseUrl: 'https://attacker.example',
        apiKey: 'secret',
      }),
    ).toThrow('Mailgun')
    expect(() => validateRelayProfile({ ...common, id: 'sendgrid', kind: 'sendgrid' })).toThrow('credentials')
  })

  it('reports static and default-chain SES authentication without exposing credentials', () => {
    const defaultChain = toRelayView({
      ...common,
      id: 'ses-role',
      kind: 'aws-ses',
      region: 'eu-west-1',
    })
    const staticCredentials = toRelayView({
      ...common,
      id: 'ses-static',
      kind: 'aws-ses',
      region: 'eu-west-1',
      accessKeyId: 'access-secret',
      secretAccessKey: 'secret-secret',
    })

    expect(defaultChain.credentialsConfigured).toBe(true)
    expect(staticCredentials.credentialsConfigured).toBe(true)
    expect(JSON.stringify(staticCredentials)).not.toContain('secret')
    expect(staticCredentials).not.toHaveProperty('accessKeyId')
  })
})
