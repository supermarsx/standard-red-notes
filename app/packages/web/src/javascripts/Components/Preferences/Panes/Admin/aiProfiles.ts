/**
 * Standard Red Notes: pure, unit-tested helpers backing the Admin AI tab's
 * MULTIPLE named assistant profiles + the guided ChatGPT/Codex pairing wizard.
 *
 * Keeping the provider metadata, draft validation and PUT-payload building here
 * (rather than inline in the React component) keeps them deterministic and
 * testable. Secrets are WRITE-ONLY: the server never returns a profile's key, so
 * a masked profile only carries `keyConfigured`. When resubmitting, an unchanged
 * key is OMITTED (the server preserves it by profile id); an explicit clear sends
 * `apiKey: null`.
 */

export type AiProfileProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'

/** A profile as returned by the masked admin server-settings view. */
export type MaskedAiProfile = {
  id: string
  name: string
  provider: AiProfileProviderKind
  baseUrl?: string | null
  model?: string | null
  models?: string[]
  enabled: boolean
  keyConfigured: boolean
  /** Standard Red Notes: optional reference to a named backend profile. */
  backendProfileId?: string | null
}

/** A profile as sent in a PUT server-settings body (secret handling per header). */
export type AiProfilePayload = {
  id: string
  name: string
  provider: AiProfileProviderKind
  baseUrl?: string | null
  model?: string | null
  models?: string[]
  enabled: boolean
  /** string = set new key; null = clear; omitted = preserve existing. */
  apiKey?: string | null
  /** Reference to a named backend profile; '' clears the link. */
  backendProfileId?: string
}

/** Editable row state in the UI: masked fields + transient key edits. */
export type ProfileRow = {
  id: string
  name: string
  provider: AiProfileProviderKind
  baseUrl: string
  model: string
  models: string[]
  enabled: boolean
  keyConfigured: boolean
  /** Newly-typed key (write-only); empty means "unchanged". */
  newKey: string
  /** When true, send apiKey:null to clear the stored key. */
  clearKey: boolean
  /** Standard Red Notes: referenced backend profile id ('' = none/embedded). */
  backendProfileId: string
}

export type ProviderOption = {
  value: AiProfileProviderKind
  label: string
  /** Whether a base URL field is meaningful for this provider. */
  supportsBaseUrl: boolean
  /** Whether server-side remote model discovery is available. */
  supportsModelDiscovery: boolean
  /** Whether a credential (key/token) is expected. */
  keyRequired: boolean
  /** Field label for the secret input. */
  keyLabel: string
  /** Placeholder hint for the base URL. */
  baseUrlPlaceholder?: string
  notes?: string
}

export const PROFILE_PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    supportsBaseUrl: false,
    supportsModelDiscovery: true,
    keyRequired: true,
    keyLabel: 'Anthropic API key',
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible',
    supportsBaseUrl: true,
    supportsModelDiscovery: true,
    keyRequired: false,
    keyLabel: 'API key (local servers may accept any)',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    notes: 'OpenAI, OpenRouter, Groq, LM Studio, Ollama (OpenAI route), or any OpenAI-compatible server.',
  },
  {
    value: 'ollama',
    label: 'Ollama (native API)',
    supportsBaseUrl: true,
    supportsModelDiscovery: true,
    keyRequired: false,
    keyLabel: 'Not required',
    baseUrlPlaceholder: 'http://localhost:11434',
  },
  {
    value: 'codex-subscription',
    label: 'ChatGPT / Codex subscription',
    supportsBaseUrl: true,
    supportsModelDiscovery: false,
    keyRequired: false,
    keyLabel: 'Subscription token (optional if paired below)',
    baseUrlPlaceholder: 'https://chatgpt.com/backend-api/codex',
    notes: 'Uses the paired ChatGPT/Codex subscription credential; pair it with the wizard below.',
  },
]

export const providerOption = (kind: AiProfileProviderKind): ProviderOption =>
  PROFILE_PROVIDER_OPTIONS.find((option) => option.value === kind) ?? PROFILE_PROVIDER_OPTIONS[0]

export const providerLabel = (kind: AiProfileProviderKind): string => providerOption(kind).label

/** Cryptographically-random, URL-safe profile id (stable across edits). */
export const generateProfileId = (): string => {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) {
    return `p-${cryptoObj.randomUUID()}`
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Convert a masked server profile into an editable row. */
export const maskedProfileToRow = (profile: MaskedAiProfile): ProfileRow => ({
  id: profile.id,
  name: profile.name,
  provider: profile.provider,
  baseUrl: profile.baseUrl ?? '',
  model: profile.model ?? '',
  models: profile.models ?? [],
  enabled: profile.enabled,
  keyConfigured: profile.keyConfigured,
  newKey: '',
  clearKey: false,
  backendProfileId: profile.backendProfileId ?? '',
})

/** A blank new-profile row with a fresh id, defaulting to OpenAI-compatible. */
export const emptyProfileRow = (): ProfileRow => ({
  id: generateProfileId(),
  name: '',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  models: [],
  enabled: true,
  keyConfigured: false,
  newKey: '',
  clearKey: false,
  backendProfileId: '',
})

export type ProfileValidation = { ok: true } | { ok: false; error: string }

const isHttpUrl = (value: string): boolean => /^https?:\/\/.+/i.test(value.trim())

/** Validates a single row before it is included in a save. */
export const validateProfileRow = (row: ProfileRow): ProfileValidation => {
  if (row.name.trim() === '') {
    return { ok: false, error: 'Each profile needs a name.' }
  }
  const option = providerOption(row.provider)
  if (row.baseUrl.trim() !== '' && !isHttpUrl(row.baseUrl)) {
    return { ok: false, error: `${row.name || 'Profile'}: base URL must be a full http(s):// URL.` }
  }
  if (!option.supportsBaseUrl && row.baseUrl.trim() !== '') {
    return { ok: false, error: `${row.name}: ${option.label} does not use a base URL.` }
  }
  return { ok: true }
}

/** Validates the whole set (rows valid, unique names help but not required, default exists). */
export const validateProfileRows = (rows: ProfileRow[], defaultProfileId: string | null): ProfileValidation => {
  for (const row of rows) {
    const result = validateProfileRow(row)
    if (!result.ok) {
      return result
    }
  }
  if (defaultProfileId && !rows.some((row) => row.id === defaultProfileId)) {
    return { ok: false, error: 'The default profile must be one of the listed profiles.' }
  }
  const enabled = rows.filter((row) => row.enabled)
  if (rows.length > 0 && enabled.length === 0) {
    return { ok: false, error: 'At least one profile must be enabled.' }
  }
  return { ok: true }
}

/** Build the write-only PUT payload for one row (secret handling per header). */
export const rowToPayload = (row: ProfileRow): AiProfilePayload => {
  const option = providerOption(row.provider)
  const payload: AiProfilePayload = {
    id: row.id,
    name: row.name.trim(),
    provider: row.provider,
    enabled: row.enabled,
  }
  if (option.supportsBaseUrl && row.baseUrl.trim() !== '') {
    payload.baseUrl = row.baseUrl.trim()
  }
  if (row.model.trim() !== '') {
    payload.model = row.model.trim()
  }
  if (row.models.length > 0) {
    payload.models = row.models
  }
  // Standard Red Notes: backend reference. A non-empty id links the profile; ''
  // is sent so the server clears any prior link (falls back to embedded fields).
  payload.backendProfileId = row.backendProfileId.trim()
  // Secret: new key wins; explicit clear sends null; otherwise omit to preserve.
  if (row.newKey.trim() !== '') {
    payload.apiKey = row.newKey.trim()
  } else if (row.clearKey) {
    payload.apiKey = null
  }
  return payload
}

/** Build the full `ai` sub-payload for a save of the profiles list + default. */
export const buildProfilesUpdate = (
  rows: ProfileRow[],
  defaultProfileId: string | null,
): { profiles: AiProfilePayload[]; defaultProfileId: string | null } => ({
  profiles: rows.map(rowToPayload),
  defaultProfileId:
    defaultProfileId && rows.some((row) => row.id === defaultProfileId)
      ? defaultProfileId
      : (rows.find((row) => row.enabled)?.id ?? rows[0]?.id ?? null),
})

/** Human summary of a profile row for the collapsed list view. */
export const profileSummary = (row: ProfileRow): string => {
  const parts = [providerLabel(row.provider)]
  if (row.model.trim() !== '') {
    parts.push(row.model.trim())
  }
  if (row.baseUrl.trim() !== '') {
    parts.push(row.baseUrl.trim())
  }
  return parts.join(' · ')
}
