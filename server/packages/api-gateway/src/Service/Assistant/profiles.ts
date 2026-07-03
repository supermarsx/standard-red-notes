import { AssistantProviderConfig } from './providers/factory'

/**
 * Standard Red Notes: MULTIPLE named Assistant profiles.
 *
 * A "profile" is a self-contained, named provider configuration (provider kind +
 * base URL + model + credential + enabled flag). The server persists an array of
 * profiles plus a `defaultProfileId` inside the ServerSettings `ai` section, and
 * the Assistant proxy resolves ONE active profile per request (the default, or a
 * per-request/x-header selected one) into a concrete provider.
 *
 * BACK-COMPAT: the legacy single-provider fields (anthropicApiKey / openaiApiKey /
 * openaiBaseUrl / ollamaUrl) keep working untouched — when no explicit profiles
 * are persisted they are mapped into synthesized default profiles, so a fresh /
 * upgraded install behaves exactly as before.
 *
 * SECRETS: a profile's `apiKey` is persisted (same trust level as the env file it
 * replaces) but is NEVER returned by any endpoint — the masked view only reports
 * a `keyConfigured` boolean, exactly like the pre-existing single-provider cards.
 */

/** The provider kinds a profile can target. */
export type AssistantProfileProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'

export const ASSISTANT_PROFILE_PROVIDER_KINDS: AssistantProfileProviderKind[] = [
  'anthropic',
  'openai-compatible',
  'ollama',
  'codex-subscription',
]

/** A profile as persisted on disk. Contains the (secret) apiKey. */
export interface PersistedAiProfile {
  id: string
  name: string
  provider: AssistantProfileProviderKind
  /** Base URL for openai-compatible / ollama / codex-subscription endpoints. */
  baseUrl?: string
  /** Default model id used when the client does not send one. */
  model?: string
  /** Optional cached list of available models (best-effort, populated by the UI). */
  models?: string[]
  /** Whether this profile is selectable. Disabled profiles never resolve. */
  enabled: boolean
  /** Secret credential (API key or subscription token). NEVER returned by any endpoint. */
  apiKey?: string
}

/** A profile as returned in the masked admin view — the secret is replaced by a boolean. */
export interface MaskedAiProfile {
  id: string
  name: string
  provider: AssistantProfileProviderKind
  baseUrl: string | null
  model: string | null
  models?: string[]
  enabled: boolean
  keyConfigured: boolean
}

/** A fully-resolved profile ready to be built into a concrete provider. */
export interface ResolvedProfileProvider {
  /** Factory provider id ('anthropic' | 'openai' | 'ollama'). */
  providerId: string
  /** Effective model for this turn. */
  model: string
  /** The AssistantProviderConfig the factory consumes. */
  config: AssistantProviderConfig
}

/** Masks a persisted profile for the admin view (drops the secret). */
export function maskProfile(profile: PersistedAiProfile): MaskedAiProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? null,
    model: profile.model ?? null,
    ...(profile.models && profile.models.length > 0 ? { models: profile.models } : {}),
    enabled: profile.enabled,
    keyConfigured: Boolean(profile.apiKey),
  }
}

export function maskProfiles(profiles: PersistedAiProfile[]): MaskedAiProfile[] {
  return profiles.map(maskProfile)
}

/**
 * Maps one profile onto the AssistantProviderConfig + factory provider id the
 * existing provider factory understands. Pure — no I/O. For codex-subscription
 * the caller may inject a fresh subscription token (see AssistantController); the
 * profile's own apiKey is used as the token fallback.
 */
export function resolveProfileProvider(profile: PersistedAiProfile, requestedModel?: string): ResolvedProfileProvider {
  const model = (requestedModel && requestedModel.trim()) || profile.model || ''

  switch (profile.provider) {
    case 'anthropic':
      return {
        providerId: 'anthropic',
        model,
        config: { anthropicApiKey: profile.apiKey },
      }
    case 'ollama':
      return {
        providerId: 'ollama',
        model,
        config: { ollamaUrl: profile.baseUrl },
      }
    case 'codex-subscription':
      return {
        providerId: 'openai',
        model,
        config: {
          openaiAuthMode: 'subscription',
          openaiSubscriptionToken: profile.apiKey,
          openaiSubscriptionBaseURL: profile.baseUrl,
          openaiModel: profile.model,
        },
      }
    case 'openai-compatible':
    default:
      return {
        providerId: 'openai',
        model,
        config: {
          openaiAuthMode: 'api-key',
          openaiApiKey: profile.apiKey,
          openaiBaseURL: profile.baseUrl,
          openaiModel: profile.model,
        },
      }
  }
}

/**
 * BACK-COMPAT: synthesize profiles from the legacy single-provider config so a
 * deployment that never defined explicit profiles still resolves. Every legacy
 * provider that is configured becomes one enabled profile with a stable id.
 */
export function legacyProfilesFromConfig(config: AssistantProviderConfig): PersistedAiProfile[] {
  const profiles: PersistedAiProfile[] = []

  if (config.anthropicApiKey) {
    profiles.push({
      id: 'legacy-anthropic',
      name: 'Anthropic (Claude)',
      provider: 'anthropic',
      model: undefined,
      enabled: true,
      apiKey: config.anthropicApiKey,
    })
  }

  const subscription = config.openaiAuthMode === 'subscription'
  const openaiConfigured = subscription
    ? Boolean(config.openaiSubscriptionToken || config.openaiSubscriptionBaseURL || config.openaiBaseURL)
    : Boolean(config.openaiApiKey || config.openaiBaseURL)
  if (openaiConfigured) {
    profiles.push({
      id: subscription ? 'legacy-codex-subscription' : 'legacy-openai',
      name: subscription ? 'ChatGPT / Codex subscription' : 'OpenAI-compatible',
      provider: subscription ? 'codex-subscription' : 'openai-compatible',
      baseUrl: subscription ? config.openaiSubscriptionBaseURL || config.openaiBaseURL : config.openaiBaseURL,
      model: config.openaiModel,
      enabled: true,
      apiKey: subscription ? config.openaiSubscriptionToken : config.openaiApiKey,
    })
  }

  if (config.ollamaUrl) {
    profiles.push({
      id: 'legacy-ollama',
      name: 'Ollama (native)',
      provider: 'ollama',
      baseUrl: config.ollamaUrl,
      enabled: true,
    })
  }

  return profiles
}

/**
 * The effective profile set + default id for a deployment: explicit persisted
 * profiles win; otherwise the legacy config is mapped into synthesized profiles.
 * `defaultProfileId` falls back to the first enabled profile.
 */
export function effectiveProfiles(
  persistedProfiles: PersistedAiProfile[] | undefined,
  persistedDefaultId: string | undefined,
  legacyConfig: AssistantProviderConfig,
): { profiles: PersistedAiProfile[]; defaultProfileId: string | undefined } {
  const profiles =
    persistedProfiles && persistedProfiles.length > 0 ? persistedProfiles : legacyProfilesFromConfig(legacyConfig)

  const enabled = profiles.filter((profile) => profile.enabled)
  const defaultProfileId =
    persistedDefaultId && profiles.some((profile) => profile.id === persistedDefaultId)
      ? persistedDefaultId
      : enabled[0]?.id ?? profiles[0]?.id

  return { profiles, defaultProfileId }
}

/**
 * Picks the active profile: the requested id (if it exists and is enabled), else
 * the default profile, else the first enabled profile. Returns undefined when no
 * usable profile exists.
 */
export function selectActiveProfile(
  profiles: PersistedAiProfile[],
  defaultProfileId: string | undefined,
  requestedId?: string,
): PersistedAiProfile | undefined {
  if (requestedId) {
    const requested = profiles.find((profile) => profile.id === requestedId && profile.enabled)
    if (requested) {
      return requested
    }
  }
  if (defaultProfileId) {
    const byDefault = profiles.find((profile) => profile.id === defaultProfileId && profile.enabled)
    if (byDefault) {
      return byDefault
    }
  }
  return profiles.find((profile) => profile.enabled)
}

/** Result of validating a PUT `ai.profiles` / `ai.defaultProfileId` payload. */
export type ProfilesValidation =
  | { profiles?: PersistedAiProfile[] | null; defaultProfileId?: string | null }
  | { error: string }

const MAX_PROFILES = 50
const MAX_NAME_LENGTH = 120

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validates the `profiles` array and `defaultProfileId` from a PUT server-settings
 * body. `null` on either clears the persisted value (falls back to legacy/env).
 * Each profile is fully validated: id + name required, provider must be a known
 * kind, base URL (when present) must be http(s), enabled must be boolean, apiKey
 * (when present) a non-empty string. Returns `{ error }` on the first problem.
 *
 * SECURITY: `apiKey === null` on a profile means "clear this profile's key";
 * `apiKey === undefined` (absent) preserves whatever key is already stored for a
 * profile with the same id (so the write-only UI never has to resend the secret).
 */
export function validateProfilesPatch(
  rawProfiles: unknown,
  rawDefaultId: unknown,
  existing: PersistedAiProfile[] | undefined,
): ProfilesValidation {
  const result: { profiles?: PersistedAiProfile[] | null; defaultProfileId?: string | null } = {}
  const existingById = new Map((existing ?? []).map((profile) => [profile.id, profile]))

  if (rawProfiles !== undefined) {
    if (rawProfiles === null) {
      result.profiles = null
    } else {
      if (!Array.isArray(rawProfiles)) {
        return { error: 'ai.profiles must be an array, or null to clear it.' }
      }
      if (rawProfiles.length > MAX_PROFILES) {
        return { error: `ai.profiles may not contain more than ${MAX_PROFILES} profiles.` }
      }
      const seenIds = new Set<string>()
      const profiles: PersistedAiProfile[] = []
      for (const entry of rawProfiles) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return { error: 'Each ai.profiles entry must be an object.' }
        }
        const raw = entry as Record<string, unknown>

        const id = typeof raw.id === 'string' ? raw.id.trim() : ''
        if (!id) {
          return { error: 'Each profile requires a non-empty string id.' }
        }
        if (seenIds.has(id)) {
          return { error: `Duplicate profile id: ${id}.` }
        }
        seenIds.add(id)

        const name = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (!name) {
          return { error: `Profile ${id} requires a non-empty name.` }
        }
        if (name.length > MAX_NAME_LENGTH) {
          return { error: `Profile ${id} name is too long (max ${MAX_NAME_LENGTH}).` }
        }

        const provider = raw.provider
        if (typeof provider !== 'string' || !ASSISTANT_PROFILE_PROVIDER_KINDS.includes(provider as AssistantProfileProviderKind)) {
          return {
            error: `Profile ${id} has an invalid provider. Expected one of: ${ASSISTANT_PROFILE_PROVIDER_KINDS.join(', ')}.`,
          }
        }

        const profile: PersistedAiProfile = {
          id,
          name,
          provider: provider as AssistantProfileProviderKind,
          enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        }

        if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
          if (typeof raw.baseUrl !== 'string' || !isHttpUrl(raw.baseUrl.trim())) {
            return { error: `Profile ${id} baseUrl must be an http(s) URL.` }
          }
          profile.baseUrl = raw.baseUrl.trim()
        }

        if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
          if (typeof raw.model !== 'string') {
            return { error: `Profile ${id} model must be a string.` }
          }
          profile.model = raw.model.trim()
        }

        if (raw.models !== undefined && raw.models !== null) {
          if (!Array.isArray(raw.models) || raw.models.some((model) => typeof model !== 'string')) {
            return { error: `Profile ${id} models must be an array of strings.` }
          }
          const models = (raw.models as string[]).map((model) => model.trim()).filter((model) => model.length > 0)
          if (models.length > 0) {
            profile.models = models
          }
        }

        // Secret handling: undefined => preserve existing key; null => clear;
        // non-empty string => set the new key.
        if (raw.apiKey === undefined) {
          const prior = existingById.get(id)
          if (prior?.apiKey) {
            profile.apiKey = prior.apiKey
          }
        } else if (raw.apiKey === null || raw.apiKey === '') {
          // cleared — leave apiKey unset
        } else if (typeof raw.apiKey === 'string') {
          profile.apiKey = raw.apiKey.trim() || undefined
        } else {
          return { error: `Profile ${id} apiKey must be a string, null, or omitted.` }
        }

        profiles.push(profile)
      }
      result.profiles = profiles
    }
  }

  if (rawDefaultId !== undefined) {
    if (rawDefaultId === null) {
      result.defaultProfileId = null
    } else if (typeof rawDefaultId === 'string' && rawDefaultId.trim() !== '') {
      result.defaultProfileId = rawDefaultId.trim()
    } else {
      return { error: 'ai.defaultProfileId must be a non-empty string, or null to clear it.' }
    }
  }

  return result
}
