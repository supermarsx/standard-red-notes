import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SubscriptionTokenStore } from '../Service/Assistant/subscription/SubscriptionTokenStore'
import { CaldavTokenStore } from '../Service/Caldav/CaldavTokenStore'
import { PublishedCalendarStore } from '../Service/Caldav/PublishedCalendarStore'
import { DeliveryConfigStore } from '../Service/ReminderDelivery/DeliveryConfigStore'
import { PublishedRemindersStore } from '../Service/ReminderDelivery/PublishedRemindersStore'
import { ServerSettingsStore } from '../Service/ServerSettings/ServerSettingsStore'
import { WorkflowsPairingStore } from '../Service/Workflows/WorkflowsPairingStore'

const TEST_ENCRYPTION_KEY = 'a'.repeat(64)
const TEST_TIMESTAMP = 1_800_000_000_000
const TEST_TOKEN_UUID = '550e8400-e29b-41d4-a716-446655440000'

function encryptSubscriptionPayload(payload: unknown): Record<string, unknown> {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(TEST_ENCRYPTION_KEY, 'hex'), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  }
}

describe('secure JSON store migrations', () => {
  let directoryPath: string

  beforeEach(async () => {
    directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-store-migrations-'))
  })

  afterEach(async () => {
    await fs.rm(directoryPath, { recursive: true, force: true })
  })

  it('rejects unknown fields in every migrated store', async () => {
    const cases: Array<{
      name: string
      value: unknown
      read(filePath: string): Promise<unknown>
    }> = [
      {
        name: 'caldav-token',
        value: {
          [TEST_TOKEN_UUID]: {
            uuid: TEST_TOKEN_UUID,
            userUuid: 'user',
            label: 'Calendar',
            scope: 'calendar-read',
            salt: 'a'.repeat(32),
            hash: 'b'.repeat(128),
            createdAt: TEST_TIMESTAMP,
            lastUsedAt: null,
            unexpected: true,
          },
        },
        read: (filePath) => new CaldavTokenStore(filePath).listForUser('user'),
      },
      {
        name: 'published-calendar',
        value: { user: { todo: { uid: 'todo', summary: 'Plan', unexpected: true } } },
        read: (filePath) => new PublishedCalendarStore(filePath).listForUser('user'),
      },
      {
        name: 'published-reminders',
        value: {
          user: {
            reminder: {
              id: 'reminder',
              message: 'Plan',
              dueAtUtc: '2030-01-01T00:00:00.000Z',
              sent: false,
              createdAt: TEST_TIMESTAMP,
              updatedAt: TEST_TIMESTAMP,
              unexpected: true,
            },
          },
        },
        read: (filePath) => new PublishedRemindersStore(filePath).listForUser('user'),
      },
      {
        name: 'delivery-config',
        value: { user: { channel: 'email', destination: 'person@example.test', enabled: true, unexpected: true } },
        read: (filePath) => new DeliveryConfigStore(filePath).getForUser('user'),
      },
      {
        name: 'workflows-pairing',
        value: {
          user: {
            userUuid: 'user',
            pairedAt: TEST_TIMESTAMP,
            mcpTokenUuid: null,
            webhookUuids: null,
            unexpected: true,
          },
        },
        read: (filePath) => new WorkflowsPairingStore(filePath).isPaired('user'),
      },
      {
        name: 'server-settings',
        value: { workflows: { enabled: true, unexpected: true } },
        read: (filePath) => new ServerSettingsStore(filePath).read(),
      },
      {
        name: 'subscription-token',
        value: { ...encryptSubscriptionPayload({ records: {} }), unexpected: true },
        read: (filePath) => new SubscriptionTokenStore(filePath, TEST_ENCRYPTION_KEY).load(),
      },
    ]

    for (const testCase of cases) {
      const filePath = path.join(directoryPath, `${testCase.name}.json`)
      await fs.writeFile(filePath, JSON.stringify(testCase.value))
      await expect(testCase.read(filePath)).rejects.toThrow(/invalid object shape/)
    }
  })

  it('rejects malformed identifiers, dates, strings, and arrays in every plaintext migrated store', async () => {
    const cases: Array<{
      name: string
      value: unknown
      read(filePath: string): Promise<unknown>
    }> = [
      {
        name: 'caldav-token-bounds',
        value: {
          [TEST_TOKEN_UUID]: {
            uuid: TEST_TOKEN_UUID,
            userUuid: 'constructor',
            label: 'Calendar',
            scope: 'calendar-read',
            salt: 'a'.repeat(32),
            hash: 'b'.repeat(128),
            createdAt: TEST_TIMESTAMP,
            lastUsedAt: null,
          },
        },
        read: (filePath) => new CaldavTokenStore(filePath).listForUser('user'),
      },
      {
        name: 'published-calendar-bounds',
        value: { user: { todo: { uid: 'todo', summary: 'Plan', due: 'tomorrow' } } },
        read: (filePath) => new PublishedCalendarStore(filePath).listForUser('user'),
      },
      {
        name: 'published-reminders-bounds',
        value: {
          user: {
            reminder: {
              id: 'reminder',
              message: 'Plan',
              dueAtUtc: 'tomorrow',
              sent: false,
              createdAt: TEST_TIMESTAMP,
              updatedAt: TEST_TIMESTAMP,
            },
          },
        },
        read: (filePath) => new PublishedRemindersStore(filePath).listForUser('user'),
      },
      {
        name: 'delivery-config-bounds',
        value: { user: { channel: 'email', destination: 'x'.repeat(8_193), enabled: true } },
        read: (filePath) => new DeliveryConfigStore(filePath).getForUser('user'),
      },
      {
        name: 'workflows-pairing-bounds',
        value: {
          user: {
            userUuid: 'user',
            pairedAt: TEST_TIMESTAMP,
            mcpTokenUuid: null,
            webhookUuids: ['prototype'],
          },
        },
        read: (filePath) => new WorkflowsPairingStore(filePath).isPaired('user'),
      },
    ]

    for (const testCase of cases) {
      const filePath = path.join(directoryPath, `${testCase.name}.json`)
      await fs.writeFile(filePath, JSON.stringify(testCase.value))
      await expect(testCase.read(filePath)).rejects.toThrow(/invalid object shape/)
    }
  })

  it('rejects malformed decrypted subscription maps, records, and ids', async () => {
    const validRecord = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: TEST_TIMESTAMP,
      pairedAt: TEST_TIMESTAMP,
    }
    const invalidPayloads = [
      { records: { default: { ...validRecord, unexpected: true } } },
      { records: { constructor: validRecord } },
      { records: { default: { ...validRecord, accessToken: '' } } },
      { records: { default: validRecord }, unexpected: true },
      {
        records: Object.fromEntries(
          Array.from({ length: 1_001 }, (_, index) => [`subscription-${index}`, validRecord]),
        ),
      },
    ]

    for (const [index, payload] of invalidPayloads.entries()) {
      const filePath = path.join(directoryPath, `subscription-decrypted-${index}.json`)
      await fs.writeFile(filePath, JSON.stringify(encryptSubscriptionPayload(payload)))
      await expect(new SubscriptionTokenStore(filePath, TEST_ENCRYPTION_KEY).loadAll()).rejects.toThrow(
        /invalid (record map|legacy record)/,
      )
    }
  })

  it('rejects every documented server-settings bound and dangling AI reference', async () => {
    const profile = { id: 'profile', name: 'Profile', provider: 'anthropic', enabled: true }
    const invalidSettings: Array<[string, unknown]> = [
      ['proof-of-work difficulty below minimum', { security: { proofOfWork: { registerDifficulty: -1 } } }],
      ['proof-of-work difficulty above maximum', { security: { proofOfWork: { signInDifficulty: 33 } } }],
      ['adaptive threshold below minimum', { security: { proofOfWork: { signInAdaptiveThreshold: -1 } } }],
      ['adaptive threshold above maximum', { security: { proofOfWork: { signInAdaptiveThreshold: 101 } } }],
      ['rate-limit window below minimum', { security: { rateLimit: { windowSeconds: 0 } } }],
      ['rate-limit window above maximum', { security: { rateLimit: { userWindowSeconds: 3_601 } } }],
      ['rate-limit maximum below minimum', { security: { rateLimit: { loginMax: -1 } } }],
      ['rate-limit maximum above maximum', { security: { rateLimit: { registrationMax: 100_001 } } }],
      ['registration maximum below minimum', { registration: { signupsPerDeviceMax: -1 } }],
      ['registration maximum above maximum', { registration: { invitesPerUser: 100_001 } }],
      ['registration window below minimum', { registration: { signupsPerIpWindowHours: 0 } }],
      ['registration window above maximum', { registration: { signupsPerDeviceWindowHours: 169 } }],
      ['weekly maximum above maximum', { registration: { signupsPerWeekMax: 1_000_001 } }],
      ['total maximum above maximum', { registration: { maxTotalAccounts: 1_000_001 } }],
      ['OCR pages below minimum', { ocr: { maxPages: 0 } }],
      ['OCR pages above maximum', { ocr: { maxPages: 1_001 } }],
      ['OCR bytes below minimum', { ocr: { maxImageBytes: 1_023 } }],
      ['OCR bytes above maximum', { ocr: { maxImageBytes: 200 * 1024 * 1024 + 1 } }],
      ['workflow TTL below minimum', { workflows: { uiTokenTtlSeconds: 59 } }],
      ['workflow TTL above maximum', { workflows: { uiTokenTtlSeconds: 604_801 } }],
      ['invalid log enum', { logging: { level: 'trace' } }],
      ['admin registration role', { registration: { defaultRole: 'ADMIN_USER' } }],
      ['invalid signup date', { registration: { signupsOpenAt: 'tomorrow' } }],
      ['invalid URL', { plugins: { repoUrl: 'ftp://plugins.example.test' } }],
      ['empty secret', { ai: { anthropicApiKey: '' } }],
      ['oversized secret', { ai: { anthropicApiKey: 'x'.repeat(256 * 1024 + 1) } }],
      ['duplicate models', { ai: { profiles: [{ ...profile, models: ['same', 'same'] }] } }],
      [
        'too many models',
        { ai: { profiles: [{ ...profile, models: Array.from({ length: 1_001 }, (_, index) => `model-${index}`) }] } },
      ],
      [
        'too many profiles',
        {
          ai: {
            profiles: Array.from({ length: 51 }, (_, index) => ({
              ...profile,
              id: `profile-${index}`,
              name: `Profile ${index}`,
            })),
          },
        },
      ],
      [
        'too many assignments',
        {
          ai: {
            profiles: [profile],
            assignments: {
              users: Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`user-${index}`, 'profile'])),
              roles: {},
            },
          },
        },
      ],
      ['dangling default profile', { ai: { profiles: [profile], defaultProfileId: 'missing' } }],
      [
        'dangling backend profile',
        { ai: { profiles: [{ ...profile, backendProfileId: 'missing' }], defaultProfileId: 'profile' } },
      ],
      [
        'dangling assignment target',
        {
          ai: {
            profiles: [profile],
            assignments: { users: { user: 'missing' }, roles: {} },
          },
        },
      ],
      [
        'invalid subscription id',
        {
          ai: {
            backendProfiles: [{ id: 'backend', name: 'Backend', type: 'subscription', subscriptionId: 'prototype' }],
          },
        },
      ],
      ['unknown profile field', { ai: { profiles: [{ ...profile, unexpected: true }] } }],
      [
        'unknown backend field',
        {
          ai: {
            backendProfiles: [
              {
                id: 'backend',
                name: 'Backend',
                type: 'api-key',
                provider: 'anthropic',
                unexpected: true,
              },
            ],
          },
        },
      ],
      [
        'unknown assignments field',
        {
          ai: {
            profiles: [profile],
            assignments: { users: {}, roles: {}, unexpected: true },
          },
        },
      ],
    ]

    for (const [name, value] of invalidSettings) {
      const filePath = path.join(directoryPath, `settings-${name.replace(/[^a-z]+/gi, '-')}.json`)
      await fs.writeFile(filePath, JSON.stringify(value))
      await expect(new ServerSettingsStore(filePath).read()).rejects.toThrow(/invalid object shape/)
    }
  })

  it('accepts exact server-settings minima, maxima, and internally consistent AI references', async () => {
    const boundaryDocuments = [
      {
        security: {
          proofOfWork: { registerDifficulty: 0, signInDifficulty: 0, signInAdaptiveThreshold: 0 },
          rateLimit: { windowSeconds: 1, loginMax: 0, registrationMax: 0, userWindowSeconds: 1, userMax: 0 },
        },
        registration: {
          defaultRole: 'CORE_USER',
          signupsPerIpMax: 0,
          signupsPerIpWindowHours: 1,
          signupsPerWeekMax: 0,
          signupsPerDeviceMax: 0,
          signupsPerDeviceWindowHours: 1,
          maxTotalAccounts: 0,
          invitesPerUser: 0,
        },
        logging: { level: 'error' },
        ocr: { maxPages: 1, maxImageBytes: 1_024 },
        workflows: { uiTokenTtlSeconds: 60 },
      },
      {
        ai: {
          profiles: [
            {
              id: 'profile',
              name: 'Profile',
              provider: 'openai-compatible',
              enabled: true,
              backendProfileId: 'backend',
              models: ['model-a', 'model-b'],
            },
          ],
          defaultProfileId: 'profile',
          backendProfiles: [
            {
              id: 'backend',
              name: 'Backend',
              type: 'subscription',
              subscriptionId: 'team-a',
              baseUrl: 'https://example.test',
            },
          ],
          assignments: { users: { 'user@example.test': 'profile' }, roles: { CORE_USER: 'profile' } },
        },
        security: {
          proofOfWork: { registerDifficulty: 32, signInDifficulty: 32, signInAdaptiveThreshold: 100 },
          rateLimit: {
            windowSeconds: 3_600,
            loginMax: 100_000,
            registrationMax: 100_000,
            userWindowSeconds: 3_600,
            userMax: 100_000,
          },
        },
        registration: {
          defaultRole: 'VAULTS_USER',
          signupsPerIpMax: 100_000,
          signupsPerIpWindowHours: 168,
          signupsPerWeekMax: 1_000_000,
          signupsPerDeviceMax: 100_000,
          signupsPerDeviceWindowHours: 168,
          maxTotalAccounts: 1_000_000,
          invitesPerUser: 100_000,
          signupsOpenAt: '2030-01-01T00:00:00.000Z',
          signupsCloseAt: null,
        },
        logging: { level: 'silly' },
        ocr: { maxPages: 1_000, maxImageBytes: 200 * 1024 * 1024 },
        workflows: { uiTokenTtlSeconds: 604_800, n8nUrl: 'https://n8n.example.test' },
      },
    ]

    for (const [index, value] of boundaryDocuments.entries()) {
      const filePath = path.join(directoryPath, `settings-boundary-${index}.json`)
      await fs.writeFile(filePath, JSON.stringify(value))
      await expect(new ServerSettingsStore(filePath).read()).resolves.toEqual(value)
    }
  })

  it('preserves the existing JSON shapes for stores that previously lacked direct round-trip specs', async () => {
    const calendarPath = path.join(directoryPath, 'calendar.json')
    const calendar = new PublishedCalendarStore(calendarPath)
    await calendar.publish('user', { uid: 'todo', summary: 'Plan release' })
    expect(JSON.parse(await fs.readFile(calendarPath, 'utf8'))).toMatchObject({
      user: { todo: { uid: 'todo', summary: 'Plan release' } },
    })

    const deliveryPath = path.join(directoryPath, 'delivery.json')
    const delivery = new DeliveryConfigStore(deliveryPath)
    await delivery.setForUser('user', { channel: 'email', destination: 'person@example.test', enabled: true })
    expect(JSON.parse(await fs.readFile(deliveryPath, 'utf8'))).toEqual({
      user: { channel: 'email', destination: 'person@example.test', enabled: true },
    })

    const workflowsPath = path.join(directoryPath, 'workflows.json')
    const workflows = new WorkflowsPairingStore(workflowsPath)
    const pairing = await workflows.pair('user')
    expect(JSON.parse(await fs.readFile(workflowsPath, 'utf8'))).toEqual({ user: pairing })

    const settingsPath = path.join(directoryPath, 'settings.json')
    const settings = new ServerSettingsStore(settingsPath)
    await settings.update({ workflows: { enabled: true, n8nUrl: 'http://127.0.0.1:5678' } })
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({
      workflows: { enabled: true, n8nUrl: 'http://127.0.0.1:5678' },
    })
  })
})
