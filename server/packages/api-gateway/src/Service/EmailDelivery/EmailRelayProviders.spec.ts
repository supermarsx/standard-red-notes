import { createServer, Socket } from 'net'

import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import SMTPConnection from 'nodemailer/lib/smtp-connection'

import { DefaultEmailRelayFactory } from './EmailRelayProviders'
import { mergeRelayConfiguration, relayConfigurationView } from './RelayConfiguration'
import { EmailDeliveryConfig, EmailRelayProfile, relaySenderAddress, toRelayView, validateRelayProfile } from './Types'

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
    expect(JSON.parse(String(init.body)).from).toEqual({
      email: 'sender@example.com',
      name: 'Standard Red Notes',
    })
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

  it('does not claim provider acceptance for an undocumented SendGrid success status', async () => {
    const relay = new DefaultEmailRelayFactory(jest.fn(async () => new Response('', { status: 200 }))).create({
      ...common,
      id: 'sendgrid-main',
      kind: 'sendgrid',
      apiKey: 'secret-api-key',
    })

    await expect(relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })).resolves.toEqual({
      outcome: 'transient-failure',
      failureClass: 'provider-protocol',
      providerCode: 'HTTP_200',
      httpStatus: 200,
    })
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

describe('AWS SES email relay provider', () => {
  it('sends a raw MIME message with an abortable SES command and requires a provider message id', async () => {
    const send = jest.fn().mockResolvedValue({ MessageId: '01020190-provider-message-id' })
    const destroy = jest.fn()
    const relay = new DefaultEmailRelayFactory(undefined, () => ({ send, destroy }) as never).create({
      ...common,
      id: 'ses-main',
      kind: 'aws-ses',
      region: 'eu-west-1',
    })

    await expect(relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })).resolves.toEqual({
      outcome: 'sent',
      providerCode: 'SES_ACCEPTED',
    })
    expect(send).toHaveBeenCalledWith(expect.any(SendEmailCommand), {
      abortSignal: expect.any(AbortSignal),
    })
    const command = send.mock.calls[0][0] as SendEmailCommand
    expect(command.input).toEqual(
      expect.objectContaining({
        FromEmailAddress: 'sender@example.com',
        Destination: { ToAddresses: ['recipient@example.com'] },
        Content: { Raw: { Data: expect.any(Uint8Array) } },
      }),
    )
    expect(Buffer.from(command.input.Content?.Raw?.Data ?? []).toString()).toContain('Subject: Subject')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('aborts a pre-dispatch SES request so it cannot send after the provider deadline', async () => {
    const lateDispatch = jest.fn()
    let capturedSignal: AbortSignal | undefined
    const send = jest.fn((_command: SendEmailCommand, options: { abortSignal: AbortSignal }) => {
      capturedSignal = options.abortSignal
      return new Promise<{ MessageId: string }>((resolve) => {
        setTimeout(() => {
          if (!options.abortSignal.aborted) {
            lateDispatch()
            resolve({ MessageId: 'late-provider-message-id' })
          }
        }, 100)
      })
    })
    const destroy = jest.fn()
    const relay = new DefaultEmailRelayFactory(undefined, () => ({ send, destroy }) as never, {
      providerTimeoutMs: 10,
    }).create({ ...common, id: 'ses-timeout', kind: 'aws-ses', region: 'eu-west-1' })

    await expect(relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })).resolves.toEqual({
      outcome: 'transient-failure',
      failureClass: 'provider-unavailable',
      providerCode: 'TimeoutError',
    })
    expect(capturedSignal?.aborted).toBe(true)
    expect(destroy).toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(lateDispatch).not.toHaveBeenCalled()
  })
})

describe('SMTP email relay provider', () => {
  it('closes the exact SMTP socket when a provider stalls before delivery', async () => {
    const sockets = new Set<Socket>()
    let clientConnection: SMTPConnection | undefined
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => {
        sockets.delete(socket)
      })
      socket.write('220 localhost ESMTP\r\n')
      // Deliberately never answer EHLO. The relay deadline must destroy this
      // active connection, not merely close a Nodemailer transport wrapper.
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('SMTP test server did not expose a TCP address.')
      }
      const relay = new DefaultEmailRelayFactory(undefined, undefined, {
        providerTimeoutMs: 50,
        smtpConnectionFactory: (options) => (clientConnection = new SMTPConnection(options)),
      }).create({
        ...common,
        id: 'smtp-timeout',
        kind: 'smtp',
        host: '127.0.0.1',
        port: address.port,
        tlsMode: 'insecure',
      })

      await expect(relay.send({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' })).resolves.toEqual({
        outcome: 'transient-failure',
        failureClass: 'transport',
        providerCode: 'ETIMEDOUT',
      })
      const internalSocket = clientConnection as unknown as {
        _socket?: { socket?: { destroyed?: boolean }; destroyed?: boolean }
      }
      const exactSocket = internalSocket._socket?.socket ?? internalSocket._socket
      expect(exactSocket?.destroyed).toBe(true)
    } finally {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
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

  it('clears SMTP identity and secret atomically and rejects a username-only rotation', () => {
    const existing: EmailDeliveryConfig = {
      relays: [
        {
          ...common,
          enabled: false,
          id: 'smtp-main',
          kind: 'smtp',
          host: 'smtp.example.com',
          port: 587,
          username: 'old-user',
          password: 'old-secret',
          tlsMode: 'starttls',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    }

    expect(() =>
      mergeRelayConfiguration(
        {
          relays: [
            {
              ...common,
              enabled: false,
              id: 'smtp-main',
              kind: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              username: 'new-user',
              tlsMode: 'starttls',
            },
          ],
          fallbackPolicy: { mode: 'none' },
        },
        existing,
      ),
    ).toThrow('requires replacing')

    const cleared = mergeRelayConfiguration(
      {
        relays: [
          {
            ...common,
            enabled: false,
            id: 'smtp-main',
            kind: 'smtp',
            host: 'smtp.example.com',
            port: 587,
            username: 'old-user',
            password: null,
            tlsMode: 'starttls',
          },
        ],
        fallbackPolicy: { mode: 'none' },
      },
      existing,
    )
    expect(cleared.relays[0]).not.toHaveProperty('username')
    expect(cleared.relays[0]).not.toHaveProperty('password')
  })

  it('rejects partial AWS static credential rotation or clearing', () => {
    const existing: EmailDeliveryConfig = {
      relays: [
        {
          ...common,
          id: 'ses-main',
          kind: 'aws-ses',
          region: 'eu-west-1',
          accessKeyId: 'old-access',
          secretAccessKey: 'old-secret',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    }
    const write = { ...common, id: 'ses-main', kind: 'aws-ses' as const, region: 'eu-west-1' }

    expect(() =>
      mergeRelayConfiguration(
        { relays: [{ ...write, accessKeyId: 'new-access' }], fallbackPolicy: { mode: 'none' } },
        existing,
      ),
    ).toThrow('together')
    expect(() =>
      mergeRelayConfiguration(
        { relays: [{ ...write, accessKeyId: null }], fallbackPolicy: { mode: 'none' } },
        existing,
      ),
    ).toThrow('together')
  })

  it('does not retain a stale SES session token when the static key pair rotates', () => {
    const existing: EmailDeliveryConfig = {
      relays: [
        {
          ...common,
          id: 'ses-main',
          kind: 'aws-ses',
          region: 'eu-west-1',
          accessKeyId: 'old-access',
          secretAccessKey: 'old-secret',
          sessionToken: 'old-session-token',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    }

    const rotated = mergeRelayConfiguration(
      {
        relays: [
          {
            ...common,
            id: 'ses-main',
            kind: 'aws-ses',
            region: 'eu-west-1',
            accessKeyId: 'new-access',
            secretAccessKey: 'new-secret',
          },
        ],
        fallbackPolicy: { mode: 'none' },
      },
      existing,
    )

    expect(rotated.relays[0]).toEqual(
      expect.objectContaining({ accessKeyId: 'new-access', secretAccessKey: 'new-secret' }),
    )
    expect(rotated.relays[0]).not.toHaveProperty('sessionToken')
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

  it('uses the canonical private-host policy for explicitly insecure SMTP', () => {
    expect(() =>
      validateRelayProfile({
        ...common,
        id: 'smtp-link-local-v6',
        kind: 'smtp',
        host: 'fe80::1',
        port: 1025,
        tlsMode: 'insecure',
      }),
    ).not.toThrow()
    expect(() =>
      validateRelayProfile({
        ...common,
        id: 'smtp-public',
        kind: 'smtp',
        host: 'smtp.example.com',
        port: 25,
        tlsMode: 'insecure',
      }),
    ).toThrow('SMTP')
  })

  it('accepts conforming sender identities and rejects malformed display names and domains', () => {
    expect(relaySenderAddress('Standard Red Notes <sender@example.com>')).toBe('sender@example.com')
    expect(relaySenderAddress('sender@example.com')).toBe('sender@example.com')
    expect(relaySenderAddress('<sender@example.com>')).toBeUndefined()
    expect(relaySenderAddress('Notes <sender@example.com> trailing')).toBeUndefined()
    expect(() =>
      validateRelayProfile({
        ...common,
        from: '@',
        id: 'sendgrid-invalid-sender',
        kind: 'sendgrid',
        apiKey: 'secret',
      }),
    ).toThrow('sender')
    expect(() =>
      validateRelayProfile({
        ...common,
        id: 'mailgun-invalid-domain',
        kind: 'mailgun',
        domain: '-invalid.example.com',
        apiKey: 'secret',
      }),
    ).toThrow('Mailgun')
  })

  it('rejects ambiguous duplicate relay priorities at the persistence boundary', () => {
    expect(() =>
      mergeRelayConfiguration(
        {
          relays: [
            { ...common, id: 'first', kind: 'sendgrid', apiKey: 'one' },
            { ...common, id: 'second', kind: 'sendgrid', apiKey: 'two' },
          ],
          fallbackPolicy: { mode: 'next-enabled' },
        },
        undefined,
      ),
    ).toThrow('priorities must be unique')
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

  it('distinguishes unauthenticated SMTP from stored SMTP credentials', () => {
    const unauthenticated = toRelayView({
      ...common,
      id: 'smtp-private',
      kind: 'smtp',
      host: '127.0.0.1',
      port: 25,
      tlsMode: 'insecure',
    })
    const authenticated = toRelayView({
      ...common,
      id: 'smtp-authenticated',
      kind: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      username: 'mailer',
      password: 'stored-secret',
      tlsMode: 'starttls',
    })

    expect(unauthenticated.credentialsConfigured).toBe(false)
    expect(authenticated.credentialsConfigured).toBe(true)
  })
})
