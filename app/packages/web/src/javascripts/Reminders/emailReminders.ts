import { SettingName, isErrorResponse } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

/**
 * The per-user opt-in setting name. NOTE: the web app consumes the PUBLISHED
 * `@standardnotes/domain-core`, whose `SettingName.NAMES` does not yet include this
 * Standard Red Notes setting, and whose `SettingName.create` rejects unknown names.
 * The server (separate dependency tree) fully recognises 'EMAIL_REMINDERS_ENABLED'.
 * The settings service only needs the name's string `value` at the wire boundary, so
 * we cast a `{ value }` object to `SettingName` exactly like the appearance/reminders
 * helpers cast their string keys at the storage boundary. This is the documented
 * cross-dep-tree workaround (same pattern as the email-backup "Monthly" gap).
 */
const EMAIL_REMINDERS_ENABLED_NAME = 'EMAIL_REMINDERS_ENABLED'
const emailRemindersEnabledSettingName = { value: EMAIL_REMINDERS_ENABLED_NAME } as unknown as SettingName

/**
 * Standard Red Notes: client helpers for the OPTIONAL email-reminder feature.
 *
 * ## E2E tradeoff (read this)
 * In-app reminders live in the note's end-to-end-encrypted appData; the server only
 * ever sees ciphertext for those. To EMAIL a reminder, the client must register that
 * reminder's `dueAt` + `message` with the server in PLAINTEXT (it leaves end-to-end
 * encryption for this feature). This is strictly per-reminder and only happens when
 * the user explicitly opts that reminder in, after the disclosure in SetReminderModal.
 *
 * Two layers of opt-in exist:
 *  1. Account-level: the per-user EMAIL_REMINDERS_ENABLED setting (this module reads
 *     and toggles it). Default disabled.
 *  2. Per-reminder: the "Also email me this reminder" checkbox, which calls
 *     `createEmailReminder` to register the single reminder.
 *
 * Whether the SERVER OPERATOR has enabled+configured email reminders at all
 * (EMAIL_REMINDERS_ENABLED env + SMTP) is not exposed via a config endpoint; if it
 * is off, registering a reminder simply results in no email being sent. The UI is
 * therefore gated on having an account (you need an account email to receive one).
 */

export type ServerEmailReminder = {
  uuid: string
  dueAt: number
  message: string
  sent: boolean
  createdAt: number
}

/** Read whether the user has opted in at the account level. Default false. */
export async function getEmailRemindersOptIn(application: WebApplication): Promise<boolean> {
  if (!application.hasAccount()) {
    return false
  }
  try {
    const settings = await application.settings.listSettings()
    return settings.getSettingValue<string, string>(emailRemindersEnabledSettingName, 'false') === 'true'
  } catch (error) {
    console.error(error)
    return false
  }
}

/** Set the account-level opt-in. Returns true on success. */
export async function setEmailRemindersOptIn(application: WebApplication, enabled: boolean): Promise<boolean> {
  try {
    await application.settings.updateSetting(emailRemindersEnabledSettingName, enabled ? 'true' : 'false', false)
    return true
  } catch (error) {
    console.error(error)
    return false
  }
}

/**
 * Register a reminder for email delivery. Sends `dueAt` (ISO) + `message` to the
 * server in PLAINTEXT. Returns the created server reminder's uuid, or null on error.
 */
export async function createEmailReminder(
  application: WebApplication,
  dueAtIso: string,
  message: string,
): Promise<string | null> {
  try {
    const response = await application.legacyApi.createEmailReminder({ dueAt: dueAtIso, message })
    if (isErrorResponse(response)) {
      return null
    }
    const data = (response as { data?: { emailReminder?: { uuid?: string } } }).data
    return data?.emailReminder?.uuid ?? null
  } catch (error) {
    console.error(error)
    return null
  }
}

export async function listEmailReminders(application: WebApplication): Promise<ServerEmailReminder[]> {
  try {
    const response = await application.legacyApi.listEmailReminders()
    if (isErrorResponse(response)) {
      return []
    }
    const data = (response as { data?: { emailReminders?: ServerEmailReminder[] } }).data
    return data?.emailReminders ?? []
  } catch (error) {
    console.error(error)
    return []
  }
}

/** Best-effort delete of a server email reminder. Swallows errors. */
export async function deleteEmailReminder(application: WebApplication, id: string): Promise<boolean> {
  try {
    const response = await application.legacyApi.deleteEmailReminder(id)
    return !isErrorResponse(response)
  } catch (error) {
    console.error(error)
    return false
  }
}
