/**
 * Standard Red Notes: pure helpers backing the Admin AI tab's DECOUPLED BACKEND
 * PROFILES editor. A backend profile is a reusable provider/connection config
 * (an api-key provider connection OR a paired subscription) that assistant
 * profiles reference by id. Secrets are WRITE-ONLY: the server never returns a
 * backend's apiKey (only `keyConfigured`); an unchanged key is OMITTED on
 * resubmit (the server preserves it by id) and an explicit clear sends
 * `apiKey: null`.
 */

import { AdminBackendProfileView } from './adminHelpers'

export type BackendProfileType = 'api-key' | 'subscription'
export type BackendApiKeyProvider = 'anthropic' | 'openai-compatible' | 'ollama'

/** A backend profile as sent in a PUT server-settings body. */
export type BackendProfilePayload = {
  id: string
  name: string
  type: BackendProfileType
  provider?: BackendApiKeyProvider
  baseUrl?: string | null
  model?: string | null
  models?: string[]
  subscriptionId?: string
  /** string = set new key; null = clear; omitted = preserve existing. */
  apiKey?: string | null
}

/** Editable row state: masked fields + transient key edits. */
export type BackendProfileRow = {
  id: string
  name: string
  type: BackendProfileType
  provider: BackendApiKeyProvider
  baseUrl: string
  model: string
  subscriptionId: string
  keyConfigured: boolean
  /** Newly-typed key (write-only); empty means "unchanged". */
  newKey: string
  /** When true, send apiKey:null to clear the stored key. */
  clearKey: boolean
}

export const BACKEND_PROVIDER_OPTIONS: { value: BackendApiKeyProvider; label: string; supportsBaseUrl: boolean }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)', supportsBaseUrl: false },
  { value: 'openai-compatible', label: 'OpenAI-compatible', supportsBaseUrl: true },
  { value: 'ollama', label: 'Ollama (native API)', supportsBaseUrl: true },
]

export const backendProviderSupportsBaseUrl = (provider: BackendApiKeyProvider): boolean =>
  BACKEND_PROVIDER_OPTIONS.find((option) => option.value === provider)?.supportsBaseUrl ?? true

/** Cryptographically-random, URL-safe backend-profile id. */
export const generateBackendProfileId = (): string => {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) {
    return `be-${cryptoObj.randomUUID()}`
  }
  return `be-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const maskedBackendToRow = (backend: AdminBackendProfileView): BackendProfileRow => ({
  id: backend.id,
  name: backend.name,
  type: backend.type,
  provider: (backend.provider ?? 'openai-compatible') as BackendApiKeyProvider,
  baseUrl: backend.baseUrl ?? '',
  model: backend.model ?? '',
  subscriptionId: backend.subscriptionId ?? '',
  keyConfigured: backend.keyConfigured,
  newKey: '',
  clearKey: false,
})

export const emptyBackendRow = (type: BackendProfileType = 'api-key'): BackendProfileRow => ({
  id: generateBackendProfileId(),
  name: '',
  type,
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  subscriptionId: type === 'subscription' ? 'default' : '',
  keyConfigured: false,
  newKey: '',
  clearKey: false,
})

export type BackendValidation = { ok: true } | { ok: false; error: string }

const isHttpUrl = (value: string): boolean => /^https?:\/\/.+/i.test(value.trim())

export const validateBackendRow = (row: BackendProfileRow): BackendValidation => {
  if (row.name.trim() === '') {
    return { ok: false, error: 'Each backend profile needs a name.' }
  }
  if (row.baseUrl.trim() !== '' && !isHttpUrl(row.baseUrl)) {
    return { ok: false, error: `${row.name || 'Backend'}: base URL must be a full http(s):// URL.` }
  }
  if (row.type === 'subscription' && row.subscriptionId.trim() === '') {
    return { ok: false, error: `${row.name || 'Backend'}: a subscription backend needs a subscription id.` }
  }
  return { ok: true }
}

export const validateBackendRows = (rows: BackendProfileRow[]): BackendValidation => {
  for (const row of rows) {
    const result = validateBackendRow(row)
    if (!result.ok) {
      return result
    }
  }
  return { ok: true }
}

export const backendRowToPayload = (row: BackendProfileRow): BackendProfilePayload => {
  const payload: BackendProfilePayload = { id: row.id, name: row.name.trim(), type: row.type }
  if (row.type === 'api-key') {
    payload.provider = row.provider
    if (backendProviderSupportsBaseUrl(row.provider) && row.baseUrl.trim() !== '') {
      payload.baseUrl = row.baseUrl.trim()
    }
    if (row.model.trim() !== '') {
      payload.model = row.model.trim()
    }
    if (row.newKey.trim() !== '') {
      payload.apiKey = row.newKey.trim()
    } else if (row.clearKey) {
      payload.apiKey = null
    }
  } else {
    payload.subscriptionId = row.subscriptionId.trim()
    if (row.baseUrl.trim() !== '') {
      payload.baseUrl = row.baseUrl.trim()
    }
    if (row.model.trim() !== '') {
      payload.model = row.model.trim()
    }
  }
  return payload
}

export const buildBackendProfilesUpdate = (
  rows: BackendProfileRow[],
): { backendProfiles: BackendProfilePayload[] } => ({
  backendProfiles: rows.map(backendRowToPayload),
})

/** Short label for a backend option in a reference dropdown. */
export const backendOptionLabel = (backend: AdminBackendProfileView): string => {
  if (backend.type === 'subscription') {
    return `${backend.name} (subscription${backend.subscriptionId ? ` · ${backend.subscriptionId}` : ''})`
  }
  return `${backend.name} (${backend.provider ?? 'api-key'})`
}
