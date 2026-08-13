import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { EmailRelayWrite } from '../EmailDelivery/RelayConfiguration'
import { ServerSettingsResolver } from './ServerSettingsResolver'
import { ServerSettingsStore } from './ServerSettingsStore'

const KEY = '11'.repeat(32)
const WRONG_KEY = '22'.repeat(32)

const common = {
  enabled: true,
  priority: 10,
  from: 'Standard Red Notes <sender@example.com>',
  rateLimit: { max: 100, windowSeconds: 60 },
}

describe('encrypted email relay settings', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-email-relays-'))
    filePath = path.join(directory, 'server-settings.json')
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  const resolver = (key: string | undefined = KEY, envBaseline = {}) =>
    new ServerSettingsResolver(new ServerSettingsStore(filePath, key), {
      assistant: {},
      ...envBaseline,
    })

  it('persists every relay kind and credential only inside authenticated ciphertext', async () => {
    const relays: EmailRelayWrite[] = [
      {
        ...common,
        priority: 20,
        id: 'smtp-main',
        name: 'SMTP',
        kind: 'smtp',
        host: 'smtp.example.com',
        port: 587,
        username: 'smtp-user',
        password: 'smtp-secret',
        tlsMode: 'starttls',
      },
      {
        ...common,
        priority: 30,
        id: 'sendgrid-main',
        name: 'SendGrid',
        kind: 'sendgrid',
        apiKey: 'sendgrid-secret',
      },
      {
        ...common,
        priority: 40,
        id: 'mailgun-main',
        name: 'Mailgun',
        kind: 'mailgun',
        domain: 'mg.example.com',
        baseUrl: 'https://api.eu.mailgun.net',
        apiKey: 'mailgun-secret',
      },
      {
        ...common,
        id: 'ses-main',
        name: 'SES',
        kind: 'aws-ses',
        region: 'eu-west-1',
        accessKeyId: 'ses-access-key',
        secretAccessKey: 'ses-secret-key',
        sessionToken: 'ses-session-token',
      },
    ]

    const view = await resolver().applyEmailRelayConfiguration({
      relays,
      fallbackPolicy: { mode: 'next-enabled' },
    })

    expect(view.configured).toBe(true)
    expect(view.relays).toHaveLength(4)
    expect(view.relays.every((relay) => relay.credentialsConfigured)).toBe(true)
    const raw = await fs.readFile(filePath, 'utf8')
    for (const privateValue of [
      'smtp.example.com',
      'smtp-user',
      'smtp-secret',
      'sendgrid-secret',
      'mg.example.com',
      'mailgun-secret',
      'ses-access-key',
      'ses-secret-key',
      'ses-session-token',
    ]) {
      expect(raw).not.toContain(privateValue)
    }
    for (const secret of [
      'smtp-secret',
      'sendgrid-secret',
      'mailgun-secret',
      'ses-access-key',
      'ses-secret-key',
      'ses-session-token',
    ]) {
      expect(JSON.stringify(view)).not.toContain(secret)
    }
    expect(JSON.parse(raw)).toEqual({
      emailDelivery: {
        relayConfigurationManaged: true,
        relayConfigurationEncrypted: {
          v: 1,
          alg: 'A256GCM',
          iv: expect.any(String),
          tag: expect.any(String),
          ciphertext: expect.any(String),
        },
      },
    })

    const full = await resolver().resolveEmailRelayConfiguration()
    expect(full.relays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'smtp-main', password: 'smtp-secret' }),
        expect.objectContaining({ id: 'sendgrid-main', apiKey: 'sendgrid-secret' }),
        expect.objectContaining({ id: 'mailgun-main', apiKey: 'mailgun-secret' }),
        expect.objectContaining({ id: 'ses-main', secretAccessKey: 'ses-secret-key' }),
      ]),
    )
  })

  it('fails closed with a missing or wrong key and on authenticated-envelope tampering', async () => {
    await resolver().applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'sendgrid-main',
          name: 'SendGrid',
          kind: 'sendgrid',
          apiKey: 'sendgrid-secret',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })

    await expect(resolver('').resolveEmailRelayConfiguration()).rejects.toThrow('server encryption key')
    await expect(resolver(WRONG_KEY).resolveEmailRelayConfiguration()).rejects.toThrow('wrong server key')

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      emailDelivery: { relayConfigurationEncrypted: { ciphertext: string } }
    }
    const ciphertext = document.emailDelivery.relayConfigurationEncrypted.ciphertext
    document.emailDelivery.relayConfigurationEncrypted.ciphertext =
      (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1)
    await fs.writeFile(filePath, JSON.stringify(document), 'utf8')

    await expect(resolver().resolveEmailRelayConfiguration()).rejects.toThrow('tampered ciphertext')
  })

  it('can deliberately clear an authenticated envelope before rotating the server key', async () => {
    const oldKeySettings = resolver()
    await oldKeySettings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'sendgrid-main',
          name: 'SendGrid',
          kind: 'sendgrid',
          apiKey: 'sendgrid-secret',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })

    await oldKeySettings.applyEmailRelayConfiguration({
      relays: [],
      fallbackPolicy: { mode: 'none' },
    })

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      emailDelivery: { relayConfigurationManaged: true },
    })
    await expect(resolver(WRONG_KEY).resolveEmailRelayConfiguration()).resolves.toEqual({
      relays: [],
      fallbackPolicy: { mode: 'none' },
    })
  })

  it('does not resurrect a valid legacy SMTP environment after every relay is removed', async () => {
    const envBaseline = {
      emailDelivery: {
        host: 'smtp.env.example',
        port: 587,
        username: 'env-user',
        password: 'env-secret',
        from: 'env@example.com',
        tlsMode: 'starttls' as const,
      },
    }
    const settings = resolver(KEY, envBaseline)
    expect((await settings.resolveEmailRelayConfiguration()).relays).toEqual([
      expect.objectContaining({ id: 'legacy-smtp' }),
    ])

    await settings.applyEmailRelayConfiguration({ relays: [], fallbackPolicy: { mode: 'none' } })

    await expect(resolver(KEY, envBaseline).resolveEmailRelayConfiguration()).resolves.toEqual({
      relays: [],
      fallbackPolicy: { mode: 'none' },
    })
  })

  it('synthesizes legacy SMTP and atomically migrates it on the first profile write', async () => {
    const store = new ServerSettingsStore(filePath, KEY)
    await store.update({
      emailDelivery: {
        host: 'smtp.legacy.example',
        port: 587,
        username: 'legacy-user',
        password: 'legacy-secret',
        from: 'legacy@example.com',
        tlsMode: 'starttls',
      },
    })
    const settings = new ServerSettingsResolver(store, { assistant: {} })

    expect(await settings.resolveEmailRelayConfiguration()).toEqual({
      relays: [
        expect.objectContaining({
          id: 'legacy-smtp',
          kind: 'smtp',
          host: 'smtp.legacy.example',
          username: 'legacy-user',
          password: 'legacy-secret',
        }),
      ],
      fallbackPolicy: { mode: 'none' },
    })

    await settings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'legacy-smtp',
          name: 'Migrated SMTP',
          kind: 'smtp',
          host: 'smtp.legacy.example',
          port: 587,
          username: 'legacy-user',
          // Omitted password must preserve the synthesized legacy credential.
          tlsMode: 'starttls',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })

    const raw = await fs.readFile(filePath, 'utf8')
    expect(raw).not.toContain('legacy-secret')
    expect(raw).not.toContain('smtp.legacy.example')
    expect((await store.read()).emailDelivery).toEqual({
      relayConfigurationManaged: true,
      relayConfigurationEncrypted: expect.any(Object),
    })
    expect(await settings.resolveEmailRelayConfiguration()).toEqual({
      relays: [expect.objectContaining({ password: 'legacy-secret' })],
      fallbackPolicy: { mode: 'none' },
    })
  })

  it('preserves omitted secrets, clears explicit nulls, and clears the AWS credential tuple coherently', async () => {
    const settings = resolver()
    await settings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'sendgrid-main',
          name: 'SendGrid',
          kind: 'sendgrid',
          apiKey: 'sendgrid-secret',
        },
        {
          ...common,
          priority: 20,
          id: 'ses-main',
          name: 'SES',
          kind: 'aws-ses',
          region: 'eu-west-1',
          accessKeyId: 'ses-access',
          secretAccessKey: 'ses-secret',
          sessionToken: 'ses-token',
        },
      ],
      fallbackPolicy: { mode: 'next-enabled' },
    })

    await settings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'sendgrid-main',
          name: 'Renamed SendGrid',
          kind: 'sendgrid',
        },
        {
          ...common,
          priority: 20,
          enabled: false,
          id: 'ses-main',
          name: 'SES',
          kind: 'aws-ses',
          region: 'eu-west-1',
          accessKeyId: null,
          secretAccessKey: null,
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })

    const full = await settings.resolveEmailRelayConfiguration()
    expect(full.relays[0]).toEqual(expect.objectContaining({ apiKey: 'sendgrid-secret' }))
    expect(full.relays[1]).not.toHaveProperty('accessKeyId')
    expect(full.relays[1]).not.toHaveProperty('secretAccessKey')
    expect(full.relays[1]).not.toHaveProperty('sessionToken')
    const view = await settings.viewEmailRelayConfiguration()
    expect(view.relays[0].credentialsConfigured).toBe(true)
    expect(view.relays[1].credentialsConfigured).toBe(true)

    await settings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          enabled: false,
          id: 'sendgrid-main',
          name: 'Renamed SendGrid',
          kind: 'sendgrid',
          apiKey: null,
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })
    expect((await settings.viewEmailRelayConfiguration()).relays[0].credentialsConfigured).toBe(false)
  })

  it('leaves legacy plaintext untouched when migration cannot encrypt', async () => {
    const store = new ServerSettingsStore(filePath)
    await store.update({
      emailDelivery: {
        host: 'smtp.legacy.example',
        password: 'legacy-secret',
        username: 'legacy-user',
        from: 'legacy@example.com',
        tlsMode: 'starttls',
      },
    })
    const settings = new ServerSettingsResolver(store, { assistant: {} })

    await expect(
      settings.applyEmailRelayConfiguration({
        relays: [
          {
            ...common,
            id: 'legacy-smtp',
            name: 'SMTP',
            kind: 'smtp',
            host: 'smtp.legacy.example',
            port: 587,
            username: 'legacy-user',
            tlsMode: 'starttls',
          },
        ],
        fallbackPolicy: { mode: 'none' },
      }),
    ).rejects.toThrow('server encryption key')

    expect(await store.read()).toEqual({
      emailDelivery: expect.objectContaining({ password: 'legacy-secret' }),
    })
  })

  it('refuses legacy plaintext writes after encrypted-profile migration', async () => {
    const store = new ServerSettingsStore(filePath, KEY)
    const settings = new ServerSettingsResolver(store, { assistant: {} })
    await settings.applyEmailRelayConfiguration({
      relays: [
        {
          ...common,
          id: 'sendgrid-main',
          name: 'SendGrid',
          kind: 'sendgrid',
          apiKey: 'sendgrid-secret',
        },
      ],
      fallbackPolicy: { mode: 'none' },
    })

    await expect(store.update({ emailDelivery: { password: 'must-not-land' } })).rejects.toThrow(
      'encrypted relay profiles',
    )
    const raw = await fs.readFile(filePath, 'utf8')
    expect(raw).not.toContain('must-not-land')
    expect((await settings.resolveEmailRelayConfiguration()).relays[0]).toEqual(
      expect.objectContaining({ apiKey: 'sendgrid-secret' }),
    )
  })
})
