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
  /** Optional profile-level generation overrides. */
  temperature?: number | null
  topP?: number | null
  maxOutputTokens?: number | null
  enabled: boolean
  keyConfigured: boolean
  /** A legacy plaintext subscription credential is present but ignored. */
  legacyInlineCredentialIgnored?: boolean
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
  temperature?: number
  topP?: number
  maxOutputTokens?: number
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
  /** Blank means inherit the server/provider default. */
  temperature: string
  /** Blank means inherit the server/provider default. */
  topP: string
  /** Blank means inherit the server/provider default. */
  maxOutputTokens: string
  enabled: boolean
  keyConfigured: boolean
  /** Non-secret server warning; cleared after the migrated profile set is saved. */
  legacyInlineCredentialIgnored: boolean
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
    keyLabel: 'Encrypted subscription pairing',
    baseUrlPlaceholder: 'https://chatgpt.com/backend-api/codex',
    notes:
      'Uses only the encrypted ChatGPT/Codex pairing store. Inline subscription tokens are rejected and never used.',
  },
]

export const providerOption = (kind: AiProfileProviderKind): ProviderOption =>
  PROFILE_PROVIDER_OPTIONS.find((option) => option.value === kind) ?? PROFILE_PROVIDER_OPTIONS[0]

export const providerLabel = (kind: AiProfileProviderKind): string => providerOption(kind).label

export type ProfileBackendView = {
  id: string
  model?: string | null
}

const optionalNumberInput = (value: number | null | undefined): string => {
  return value === null || value === undefined ? '' : `${value}`
}

const parsedOptionalNumber = (value: string): number | undefined => {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

const validateOptionalNumber = (
  value: string,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): string | undefined => {
  const parsed = parsedOptionalNumber(value)
  if (parsed === undefined) {
    return undefined
  }
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    const kind = integer ? 'whole number' : 'number'
    return `${label} must be a ${kind} from ${minimum} to ${maximum}.`
  }
  return undefined
}

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
  temperature: optionalNumberInput(profile.temperature),
  topP: optionalNumberInput(profile.topP),
  maxOutputTokens: optionalNumberInput(profile.maxOutputTokens),
  enabled: profile.enabled,
  keyConfigured: profile.keyConfigured,
  legacyInlineCredentialIgnored: Boolean(profile.legacyInlineCredentialIgnored),
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
  temperature: '',
  topP: '',
  maxOutputTokens: '',
  enabled: true,
  keyConfigured: false,
  legacyInlineCredentialIgnored: false,
  newKey: '',
  clearKey: false,
  backendProfileId: '',
})

export type ProfileValidation = { ok: true } | { ok: false; error: string }

const isHttpUrl = (value: string): boolean => /^https?:\/\/.+/i.test(value.trim())

/** Validates a single row before it is included in a save. */
export const validateProfileRow = (row: ProfileRow, backendProfiles: ProfileBackendView[] = []): ProfileValidation => {
  if (row.name.trim() === '') {
    return { ok: false, error: 'Each profile needs a name.' }
  }
  const option = providerOption(row.provider)
  const usesBackend = row.backendProfileId.trim() !== ''
  const selectedBackend = usesBackend
    ? backendProfiles.find((backend) => backend.id === row.backendProfileId.trim())
    : undefined
  if (usesBackend && !selectedBackend) {
    return { ok: false, error: `${row.name || 'Profile'}: select an available backend profile.` }
  }
  if (!usesBackend && row.baseUrl.trim() !== '' && !isHttpUrl(row.baseUrl)) {
    return { ok: false, error: `${row.name || 'Profile'}: base URL must be a full http(s):// URL.` }
  }
  if (!usesBackend && !option.supportsBaseUrl && row.baseUrl.trim() !== '') {
    return { ok: false, error: `${row.name}: ${option.label} does not use a base URL.` }
  }
  if (!usesBackend && row.provider === 'codex-subscription' && row.newKey.trim() !== '') {
    return {
      ok: false,
      error: `${row.name || 'Profile'}: pair the subscription below instead of storing a token in the profile.`,
    }
  }
  const effectiveModel = row.model.trim() || selectedBackend?.model?.trim() || ''
  if (row.enabled && effectiveModel === '') {
    return {
      ok: false,
      error:
        `${row.name || 'Profile'}: set a model on this assistant profile` +
        (usesBackend ? ' or set a default model on its selected backend.' : '.'),
    }
  }
  const temperatureError = validateOptionalNumber(row.temperature, `${row.name || 'Profile'} temperature`, 0, 2)
  if (temperatureError) {
    return { ok: false, error: temperatureError }
  }
  const topPError = validateOptionalNumber(row.topP, `${row.name || 'Profile'} top-p`, 0, 1)
  if (topPError) {
    return { ok: false, error: topPError }
  }
  const maxOutputTokensError = validateOptionalNumber(
    row.maxOutputTokens,
    `${row.name || 'Profile'} maximum output tokens`,
    1,
    200_000,
    true,
  )
  if (maxOutputTokensError) {
    return { ok: false, error: maxOutputTokensError }
  }
  return { ok: true }
}

/** Validates the whole set (rows valid, unique names help but not required, default exists). */
export const validateProfileRows = (
  rows: ProfileRow[],
  defaultProfileId: string | null,
  backendProfiles: ProfileBackendView[] = [],
): ProfileValidation => {
  for (const row of rows) {
    const result = validateProfileRow(row, backendProfiles)
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
  const temperature = parsedOptionalNumber(row.temperature)
  if (temperature !== undefined) {
    payload.temperature = temperature
  }
  const topP = parsedOptionalNumber(row.topP)
  if (topP !== undefined) {
    payload.topP = topP
  }
  const maxOutputTokens = parsedOptionalNumber(row.maxOutputTokens)
  if (maxOutputTokens !== undefined) {
    payload.maxOutputTokens = maxOutputTokens
  }
  // Standard Red Notes: backend reference. A non-empty id links the profile; ''
  // is sent so the server clears any prior link (falls back to embedded fields).
  payload.backendProfileId = row.backendProfileId.trim()
  // Secret: new key wins; explicit clear sends null; otherwise omit to preserve.
  if (row.provider === 'codex-subscription') {
    // Omit the secret field. The server treats omission as a migration save and
    // removes any legacy plaintext subscription token.
  } else if (row.newKey.trim() !== '') {
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
