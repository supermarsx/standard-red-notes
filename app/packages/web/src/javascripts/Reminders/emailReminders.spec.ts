import { WebApplication } from '@/Application/WebApplication'
import {
  createEmailReminder,
  deleteEmailReminder,
  getEmailRemindersOptIn,
  listEmailReminders,
  setEmailRemindersOptIn,
} from './emailReminders'

/**
 * Standard Red Notes: tests for the email-reminder client helpers.
 *
 * These wrap `application.settings` (account-level opt-in) and
 * `application.legacyApi` (per-reminder registration). We mock those collaborators
 * and assert the error-swallowing + opt-in defaulting behaviour, which is the bulk
 * of this module's logic.
 */

const okResponse = (data: unknown) => ({ status: 200, data })
const errorBodyResponse = () => ({ status: 200, data: { error: { message: 'nope' } } })
const httpErrorResponse = () => ({ status: 500, data: {} })

type SettingsMock = {
  listSettings: jest.Mock
  updateSetting: jest.Mock
}

type LegacyApiMock = {
  createEmailReminder: jest.Mock
  listEmailReminders: jest.Mock
  deleteEmailReminder: jest.Mock
}

const makeApplication = (opts: {
  hasAccount?: boolean
  settings?: Partial<SettingsMock>
  legacyApi?: Partial<LegacyApiMock>
}): WebApplication =>
  ({
    hasAccount: () => opts.hasAccount ?? true,
    settings: {
      listSettings: jest.fn(),
      updateSetting: jest.fn(),
      ...opts.settings,
    },
    legacyApi: {
      createEmailReminder: jest.fn(),
      listEmailReminders: jest.fn(),
      deleteEmailReminder: jest.fn(),
      ...opts.legacyApi,
    },
  }) as unknown as WebApplication

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('getEmailRemindersOptIn', () => {
  it('returns false without calling settings when there is no account', async () => {
    const listSettings = jest.fn()
    const app = makeApplication({ hasAccount: false, settings: { listSettings } })
    await expect(getEmailRemindersOptIn(app)).resolves.toBe(false)
    expect(listSettings).not.toHaveBeenCalled()
  })

  it('returns true only when the stored setting value is the string "true"', async () => {
    const app = makeApplication({
      settings: {
        listSettings: jest.fn().mockResolvedValue({
          getSettingValue: () => 'true',
        }),
      },
    })
    await expect(getEmailRemindersOptIn(app)).resolves.toBe(true)
  })

  it('returns false when the setting is absent (uses the "false" default)', async () => {
    const app = makeApplication({
      settings: {
        listSettings: jest.fn().mockResolvedValue({
          // Echo back whatever default was passed, mirroring the real API.
          getSettingValue: (_name: unknown, fallback: string) => fallback,
        }),
      },
    })
    await expect(getEmailRemindersOptIn(app)).resolves.toBe(false)
  })

  it('swallows errors from listSettings and returns false', async () => {
    const app = makeApplication({
      settings: { listSettings: jest.fn().mockRejectedValue(new Error('boom')) },
    })
    await expect(getEmailRemindersOptIn(app)).resolves.toBe(false)
  })
})

describe('setEmailRemindersOptIn', () => {
  it('persists "true"/"false" string values and returns true on success', async () => {
    const updateSetting = jest.fn().mockResolvedValue(undefined)
    const app = makeApplication({ settings: { updateSetting } })

    await expect(setEmailRemindersOptIn(app, true)).resolves.toBe(true)
    expect(updateSetting).toHaveBeenCalledWith(expect.anything(), 'true', false)

    await expect(setEmailRemindersOptIn(app, false)).resolves.toBe(true)
    expect(updateSetting).toHaveBeenLastCalledWith(expect.anything(), 'false', false)
  })

  it('returns false when updateSetting rejects', async () => {
    const app = makeApplication({
      settings: { updateSetting: jest.fn().mockRejectedValue(new Error('boom')) },
    })
    await expect(setEmailRemindersOptIn(app, true)).resolves.toBe(false)
  })
})

describe('createEmailReminder', () => {
  it('returns the created reminder uuid on success', async () => {
    const app = makeApplication({
      legacyApi: {
        createEmailReminder: jest.fn().mockResolvedValue(okResponse({ emailReminder: { uuid: 'abc' } })),
      },
    })
    await expect(createEmailReminder(app, '2026-06-20T13:00:00.000Z', 'msg')).resolves.toBe('abc')
    expect(app.legacyApi.createEmailReminder).toHaveBeenCalledWith({
      dueAt: '2026-06-20T13:00:00.000Z',
      message: 'msg',
    })
  })

  it('returns null when the payload lacks a uuid', async () => {
    const app = makeApplication({
      legacyApi: { createEmailReminder: jest.fn().mockResolvedValue(okResponse({})) },
    })
    await expect(createEmailReminder(app, 'd', 'm')).resolves.toBeNull()
  })

  it('returns null on an error-body response', async () => {
    const app = makeApplication({
      legacyApi: { createEmailReminder: jest.fn().mockResolvedValue(errorBodyResponse()) },
    })
    await expect(createEmailReminder(app, 'd', 'm')).resolves.toBeNull()
  })

  it('returns null on an HTTP-error status response', async () => {
    const app = makeApplication({
      legacyApi: { createEmailReminder: jest.fn().mockResolvedValue(httpErrorResponse()) },
    })
    await expect(createEmailReminder(app, 'd', 'm')).resolves.toBeNull()
  })

  it('returns null when the request throws', async () => {
    const app = makeApplication({
      legacyApi: { createEmailReminder: jest.fn().mockRejectedValue(new Error('network')) },
    })
    await expect(createEmailReminder(app, 'd', 'm')).resolves.toBeNull()
  })
})

describe('listEmailReminders', () => {
  it('returns the reminders array on success', async () => {
    const reminders = [{ uuid: 'a', dueAt: 1, message: 'm', sent: false, createdAt: 1 }]
    const app = makeApplication({
      legacyApi: { listEmailReminders: jest.fn().mockResolvedValue(okResponse({ emailReminders: reminders })) },
    })
    await expect(listEmailReminders(app)).resolves.toEqual(reminders)
  })

  it('returns [] when the payload has no reminders', async () => {
    const app = makeApplication({
      legacyApi: { listEmailReminders: jest.fn().mockResolvedValue(okResponse({})) },
    })
    await expect(listEmailReminders(app)).resolves.toEqual([])
  })

  it('returns [] on an error response', async () => {
    const app = makeApplication({
      legacyApi: { listEmailReminders: jest.fn().mockResolvedValue(errorBodyResponse()) },
    })
    await expect(listEmailReminders(app)).resolves.toEqual([])
  })

  it('returns [] when the request throws', async () => {
    const app = makeApplication({
      legacyApi: { listEmailReminders: jest.fn().mockRejectedValue(new Error('network')) },
    })
    await expect(listEmailReminders(app)).resolves.toEqual([])
  })
})

describe('deleteEmailReminder', () => {
  it('returns true on a successful delete', async () => {
    const app = makeApplication({
      legacyApi: { deleteEmailReminder: jest.fn().mockResolvedValue(okResponse({})) },
    })
    await expect(deleteEmailReminder(app, 'id')).resolves.toBe(true)
    expect(app.legacyApi.deleteEmailReminder).toHaveBeenCalledWith('id')
  })

  it('returns false on an error response', async () => {
    const app = makeApplication({
      legacyApi: { deleteEmailReminder: jest.fn().mockResolvedValue(httpErrorResponse()) },
    })
    await expect(deleteEmailReminder(app, 'id')).resolves.toBe(false)
  })

  it('returns false when the request throws', async () => {
    const app = makeApplication({
      legacyApi: { deleteEmailReminder: jest.fn().mockRejectedValue(new Error('network')) },
    })
    await expect(deleteEmailReminder(app, 'id')).resolves.toBe(false)
  })
})
