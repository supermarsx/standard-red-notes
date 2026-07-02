import { SettingName, isErrorResponse } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: client helpers for the OPTIONAL server-side reminder
 * DELIVERY feature (WhatsApp / Telegram / email).
 *
 * ## E2E tradeoff (read this)
 * In-app reminders live in the note's end-to-end-encrypted appData; the server
 * only ever sees ciphertext for those. To DELIVER a reminder over an external
 * channel, the server can only act on a per-user delivery config (channel +
 * destination) and on reminders the user has EXPLICITLY published in PLAINTEXT.
 * This mirrors the CalDAV published-calendar / email-reminders model: opt-in, OFF
 * by default, never exposing any other E2E data.
 *
 * Two gates exist server-side (both must be true before delivery-config or
 * publishing work):
 *  1. Operator: the REMINDER_DELIVERY_ENABLED env master switch (reported by the
 *     `/config` endpoint as `reminderDeliveryEnabled`).
 *  2. Account: the per-user REMINDER_DELIVERY_ENABLED setting (this module reads
 *     and toggles it; reported by `/config` as `allowed`). Default disabled.
 *
 * NOTE: the web app consumes the PUBLISHED `@standardnotes/domain-core`, whose
 * `SettingName.NAMES` does not include this Standard Red Notes setting and whose
 * `SettingName.create` rejects unknown names. The settings service only needs the
 * name's string `value` at the wire boundary, so we cast a `{ value }` object to
 * `SettingName` exactly like the email-reminders helper does. This is the
 * documented cross-dep-tree workaround.
 */

const REMINDER_DELIVERY_ENABLED_NAME = 'REMINDER_DELIVERY_ENABLED'
const reminderDeliveryEnabledSettingName = { value: REMINDER_DELIVERY_ENABLED_NAME } as unknown as SettingName

export type DeliveryChannel = 'whatsapp' | 'telegram' | 'email'

export const DELIVERY_CHANNELS: DeliveryChannel[] = ['whatsapp', 'telegram', 'email']

export type ReminderDeliveryConfig = {
  /** The operator env master switch. */
  reminderDeliveryEnabled: boolean
  /** The per-user opt-in setting. */
  allowed: boolean
  /** enabled && allowed — the feature is fully usable. */
  available: boolean
}

export type DeliveryConfig = {
  channel: DeliveryChannel
  destination: string
  enabled: boolean
}

export type PublishedReminder = {
  id: string
  message: string
  dueAtUtc: string
  channel?: DeliveryChannel
  destination?: string
  sent: boolean
  sentAt?: number
  error?: string
  createdAt: number
  updatedAt: number
}

// ---- pure helpers (unit-tested) ----

/** Human label for a channel. */
export function channelLabel(channel: DeliveryChannel): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'telegram':
      return 'Telegram'
    case 'email':
      return 'Email'
  }
}

/** Label for the destination field, appropriate to the channel. */
export function destinationLabel(channel: DeliveryChannel): string {
  switch (channel) {
    case 'whatsapp':
      return 'Phone number'
    case 'telegram':
      return 'Telegram chat ID'
    case 'email':
      return 'Email address'
  }
}

/** Placeholder text for the destination field, appropriate to the channel. */
export function destinationPlaceholder(channel: DeliveryChannel): string {
  switch (channel) {
    case 'whatsapp':
      return '+15551234567'
    case 'telegram':
      return '123456789'
    case 'email':
      return 'you@example.com'
  }
}

/** One-line helper text explaining what to enter for the channel. */
export function destinationHint(channel: DeliveryChannel): string {
  switch (channel) {
    case 'whatsapp':
      return 'Your phone number in international format, with country code (e.g. +15551234567).'
    case 'telegram':
      return 'The numeric chat ID of your chat with the server’s Telegram bot (message the bot, then use a tool like @userinfobot to find your ID).'
    case 'email':
      return 'The email address reminders should be sent to. It does not have to be your account email.'
  }
}

/**
 * Light client-side validation of a destination for a channel. Returns an error
 * message when invalid, or null when acceptable. The server is authoritative;
 * this only catches obvious mistakes before a round-trip.
 */
export function validateDestination(channel: DeliveryChannel, destination: string): string | null {
  const value = destination.trim()
  if (value.length === 0) {
    return `A ${destinationLabel(channel).toLowerCase()} is required.`
  }
  switch (channel) {
    case 'whatsapp': {
      // E.164-ish: optional leading +, 7–15 digits.
      if (!/^\+?[0-9]{7,15}$/.test(value)) {
        return 'Enter a valid phone number in international format, e.g. +15551234567.'
      }
      return null
    }
    case 'telegram': {
      // Telegram chat ids are numeric (may be negative for groups).
      if (!/^-?[0-9]{1,20}$/.test(value)) {
        return 'Enter a numeric Telegram chat ID.'
      }
      return null
    }
    case 'email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'Enter a valid email address.'
      }
      return null
    }
  }
}

export function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return typeof value === 'string' && (DELIVERY_CHANNELS as string[]).includes(value)
}

// ---- account opt-in setting ----

/** Read whether the user has opted in at the account level. Default false. */
export async function getReminderDeliveryOptIn(application: WebApplication): Promise<boolean> {
  if (!application.hasAccount()) {
    return false
  }
  try {
    const settings = await application.settings.listSettings()
    return settings.getSettingValue<string, string>(reminderDeliveryEnabledSettingName, 'false') === 'true'
  } catch (error) {
    console.error(error)
    return false
  }
}

/** Set the account-level opt-in. Returns true on success. */
export async function setReminderDeliveryOptIn(application: WebApplication, enabled: boolean): Promise<boolean> {
  try {
    await application.settings.updateSetting(reminderDeliveryEnabledSettingName, enabled ? 'true' : 'false', false)
    // The opt-in gates the delivery-config routes server-side; drop the cached
    // gate decision so the next reminder save re-evaluates against the server.
    deliveryStateCache = null
    return true
  } catch (error) {
    console.error(error)
    return false
  }
}

// ---- server config / delivery config ----

/** Whether the feature is enabled on this server and allowed for this user. */
export async function getReminderDeliveryConfig(application: WebApplication): Promise<ReminderDeliveryConfig> {
  const disabled: ReminderDeliveryConfig = { reminderDeliveryEnabled: false, allowed: false, available: false }
  if (!application.hasAccount()) {
    return disabled
  }
  try {
    const response = await application.legacyApi.getReminderDeliveryConfig()
    if (isErrorResponse(response)) {
      return disabled
    }
    const data = (response as { data?: Partial<ReminderDeliveryConfig> }).data
    return {
      reminderDeliveryEnabled: Boolean(data?.reminderDeliveryEnabled),
      allowed: Boolean(data?.allowed),
      available: Boolean(data?.available),
    }
  } catch (error) {
    console.error(error)
    return disabled
  }
}

/** Read the current per-user delivery config (channel/destination/enabled). */
export async function getDeliveryConfig(application: WebApplication): Promise<DeliveryConfig | null> {
  try {
    const response = await application.legacyApi.getReminderDeliveryDeliveryConfig()
    if (isErrorResponse(response)) {
      return null
    }
    const data = (response as { data?: { config?: DeliveryConfig | null } }).data
    const config = data?.config
    if (!config || !isDeliveryChannel(config.channel)) {
      return null
    }
    return { channel: config.channel, destination: config.destination ?? '', enabled: Boolean(config.enabled) }
  } catch (error) {
    console.error(error)
    return null
  }
}

/** Save the per-user delivery config. Returns the saved config, or null on error. */
export async function setDeliveryConfig(
  application: WebApplication,
  config: DeliveryConfig,
): Promise<DeliveryConfig | null> {
  try {
    const response = await application.legacyApi.setReminderDeliveryDeliveryConfig({
      channel: config.channel,
      destination: config.destination,
      enabled: config.enabled,
    })
    if (isErrorResponse(response)) {
      return null
    }
    const data = (response as { data?: { config?: DeliveryConfig } }).data
    const saved = data?.config ?? config
    // Keep the automatic publish gate below in sync immediately (no TTL wait).
    deliveryStateCache = { config: saved, fetchedAt: Date.now() }
    return saved
  } catch (error) {
    console.error(error)
    return null
  }
}

/** List the reminders the user has published for server delivery. */
export async function listPublishedReminders(application: WebApplication): Promise<PublishedReminder[]> {
  try {
    const response = await application.legacyApi.listReminderDeliveries()
    if (isErrorResponse(response)) {
      return []
    }
    const data = (response as { data?: { reminders?: PublishedReminder[] } }).data
    return data?.reminders ?? []
  } catch (error) {
    console.error(error)
    return []
  }
}

/**
 * Publish a single reminder for server-side delivery, in PLAINTEXT. Best-effort
 * and additive: callers use it alongside the existing in-app / email reminder
 * paths and must only call it for reminders the user explicitly opted in.
 * Returns true on success.
 */
export async function publishReminderForDelivery(
  application: WebApplication,
  reminder: { id: string; message: string; dueAtIso: string; channel?: DeliveryChannel; destination?: string },
): Promise<boolean> {
  try {
    const response = await application.legacyApi.publishReminderDelivery({
      id: reminder.id,
      message: reminder.message,
      dueAtUtc: reminder.dueAtIso,
      ...(reminder.channel ? { channel: reminder.channel } : {}),
      ...(reminder.destination ? { destination: reminder.destination } : {}),
    })
    return !isErrorResponse(response)
  } catch (error) {
    console.error(error)
    return false
  }
}

/** Best-effort unpublish of a published reminder. Swallows errors. */
export async function unpublishReminderForDelivery(application: WebApplication, id: string): Promise<boolean> {
  try {
    const response = await application.legacyApi.deleteReminderDelivery(id)
    return !isErrorResponse(response)
  } catch (error) {
    console.error(error)
    return false
  }
}

// ---- automatic publish/unpublish gate (used by NotesController) ----

/**
 * Cached "should the client mirror reminders to the delivery store?" decision so
 * saving a reminder does not cost a config round-trip every time. TTL keeps a
 * Preferences change (enable/disable) effective within a minute on other code
 * paths; the Preferences pane itself always talks to the server directly.
 */
type DeliveryState = { config: DeliveryConfig | null; fetchedAt: number }
let deliveryStateCache: DeliveryState | null = null
const DELIVERY_STATE_TTL_MS = 60_000

export function resetReminderDeliveryStateCacheForTests(): void {
  deliveryStateCache = null
}

async function getCachedDeliveryConfig(application: WebApplication): Promise<DeliveryConfig | null> {
  const now = Date.now()
  if (deliveryStateCache && now - deliveryStateCache.fetchedAt < DELIVERY_STATE_TTL_MS) {
    return deliveryStateCache.config
  }
  // getDeliveryConfig returns null when the feature is off, the user has not
  // opted in (the route 403s), or the server predates the feature — all of
  // which correctly disable the automatic mirror below.
  const config = await getDeliveryConfig(application)
  deliveryStateCache = { config, fetchedAt: now }
  return config
}

/**
 * Publish a reminder for server-side delivery IF (and only if) the user has an
 * ENABLED delivery config. Fire-and-forget safe: never throws, degrades silently
 * (log-gated) when the feature is off / not opted in / the endpoint is absent.
 * Re-publishing an edited or advanced reminder under the same id updates the
 * server record and re-arms delivery when the due time changed.
 */
export async function maybePublishReminderForDelivery(
  application: WebApplication,
  reminder: { id: string; dueAt: string; message?: string },
): Promise<boolean> {
  try {
    if (!application.hasAccount()) {
      return false
    }
    const config = await getCachedDeliveryConfig(application)
    if (!config || !config.enabled) {
      return false
    }
    return await publishReminderForDelivery(application, {
      id: reminder.id,
      message: reminder.message?.trim() || 'Reminder',
      dueAtIso: reminder.dueAt,
    })
  } catch (error) {
    console.error(error)
    return false
  }
}

/**
 * Unpublish a cleared/removed reminder IF the user has a delivery config at all
 * (enabled or not — a disabled config can be re-enabled later, and the stale
 * record would then deliver). Fire-and-forget safe; degrades silently.
 */
export async function maybeUnpublishReminderForDelivery(application: WebApplication, id: string): Promise<boolean> {
  try {
    if (!application.hasAccount()) {
      return false
    }
    const config = await getCachedDeliveryConfig(application)
    if (!config) {
      return false
    }
    return await unpublishReminderForDelivery(application, id)
  } catch (error) {
    console.error(error)
    return false
  }
}
