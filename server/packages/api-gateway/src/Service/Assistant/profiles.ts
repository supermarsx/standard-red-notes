import { hasOnlyKeys, isBoundedString, isSafeRecordKey } from '../../Infra/SecureJsonFileStore'
import { AssistantProviderConfig } from './providers/factory'
import { isValidSubscriptionId } from './subscription/pairingValidation'

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
 * SECRETS: an ordinary provider profile's `apiKey` is persisted (same trust level
 * as the env file it replaces) but is NEVER returned by any endpoint — the masked
 * view only reports a `keyConfigured` boolean. Subscription credentials are the
 * exception: they belong only in the encrypted pairing store, and inline values
 * are rejected or removed during legacy migration.
 */

/** The provider kinds a profile can target. */
export type AssistantProfileProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'

export const ASSISTANT_PROFILE_PROVIDER_KINDS: AssistantProfileProviderKind[] = [
  'anthropic',
  'openai-compatible',
  'ollama',
  'codex-subscription',
]

export const ASSISTANT_PROFILE_LIMITS = {
  profiles: 50,
  idLength: 256,
  nameLength: 120,
  modelCount: 1_000,
  modelLength: 512,
  urlLength: 8_192,
  secretLength: 256 * 1024,
  subscriptionIdLength: 128,
  assignmentCount: 10_000,
  userIdentifierLength: 320,
} as const

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
  /** Optional server-owned generation overrides. */
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  /** Resolved backend transport controls; persisted only on legacy embedded profiles when explicitly supplied. */
  wireProtocol?: 'chat-completions' | 'responses'
  timeoutMs?: number
  maxRetries?: number
  /** Whether this profile is selectable. Disabled profiles never resolve. */
  enabled: boolean
  /** Secret credential (API key or subscription token). NEVER returned by any endpoint. */
  apiKey?: string
  /**
   * Standard Red Notes: DECOUPLED BACKEND LAYER. When set, this assistant profile
   * REFERENCES a named backend profile (see PersistedBackendProfile) for its
   * provider/connection/credential instead of embedding them. Absent keeps the
   * legacy self-contained behavior (provider + apiKey above) so existing configs
   * resolve unchanged. Resolution merges the backend on top (see
   * resolveEffectiveAssistantProfile).
   */
  backendProfileId?: string
  /**
   * Populated ONLY during resolution when the referenced backend profile is a
   * subscription backend — it names WHICH paired subscription credential the
   * proxy must draw a fresh token from. Never sent by clients; never persisted on
   * the assistant profile itself.
   */
  subscriptionId?: string
}

/**
 * A profile as returned in the masked admin view. Ordinary provider secrets are
 * replaced by a boolean. Legacy plaintext subscription tokens are never treated
 * as configured; a non-secret warning tells the admin that the ignored value
 * will be removed the next time profiles are saved.
 */
export interface MaskedAiProfile {
  id: string
  name: string
  provider: AssistantProfileProviderKind
  baseUrl: string | null
  model: string | null
  models?: string[]
  temperature: number | null
  topP: number | null
  maxOutputTokens: number | null
  enabled: boolean
  keyConfigured: boolean
  legacyInlineCredentialIgnored: boolean
  backendProfileId: string | null
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
  const legacyInlineCredentialIgnored = profile.provider === 'codex-subscription' && Boolean(profile.apiKey)
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? null,
    model: profile.model ?? null,
    ...(profile.models && profile.models.length > 0 ? { models: profile.models } : {}),
    temperature: profile.temperature ?? null,
    topP: profile.topP ?? null,
    maxOutputTokens: profile.maxOutputTokens ?? null,
    enabled: profile.enabled,
    keyConfigured: profile.provider !== 'codex-subscription' && Boolean(profile.apiKey),
    legacyInlineCredentialIgnored,
    backendProfileId: profile.backendProfileId ?? null,
  }
}

export function maskProfiles(profiles: PersistedAiProfile[]): MaskedAiProfile[] {
  return profiles.map(maskProfile)
}

/**
 * Maps one profile onto the AssistantProviderConfig + factory provider id the
 * existing provider factory understands. Pure — no I/O. For codex-subscription
 * the caller may inject a fresh subscription token (see AssistantController); the
 * durable pairing is authoritative. A legacy plaintext apiKey on such a profile
 * is deliberately ignored and never copied into provider configuration.
 */
export function resolveProfileProvider(profile: PersistedAiProfile, requestedModel?: string): ResolvedProfileProvider {
  const model = (requestedModel && requestedModel.trim()) || profile.model || ''

  switch (profile.provider) {
    case 'anthropic':
      return {
        providerId: 'anthropic',
        model,
        config: {
          anthropicApiKey: profile.apiKey,
          requestTimeoutMs: profile.timeoutMs,
          maxRetries: profile.maxRetries,
        },
      }
    case 'ollama':
      return {
        providerId: 'ollama',
        model,
        config: {
          ollamaUrl: profile.baseUrl,
          requestTimeoutMs: profile.timeoutMs,
          maxRetries: profile.maxRetries,
        },
      }
    case 'codex-subscription':
      return {
        providerId: 'openai',
        model,
        config: {
          openaiAuthMode: 'subscription',
          openaiSubscriptionToken: undefined,
          openaiSubscriptionBaseURL: profile.baseUrl,
          openaiModel: profile.model,
          openaiWireProtocol: 'responses',
          requestTimeoutMs: profile.timeoutMs,
          maxRetries: profile.maxRetries,
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
          openaiWireProtocol: profile.wireProtocol,
          requestTimeoutMs: profile.timeoutMs,
          maxRetries: profile.maxRetries,
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
      // Never project a legacy subscription bearer into the profile's plaintext
      // apiKey field. The controller can consult the boot-time env config only
      // when encrypted pairing is not configured.
      apiKey: subscription ? undefined : config.openaiApiKey,
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
      : (enabled[0]?.id ?? profiles[0]?.id)

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
  { profiles?: PersistedAiProfile[] | null; defaultProfileId?: string | null } | { error: string }

function isHttpUrl(value: string): boolean {
  if (!isBoundedString(value, 1, ASSISTANT_PROFILE_LIMITS.urlLength)) {
    return false
  }
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
      if (rawProfiles.length > ASSISTANT_PROFILE_LIMITS.profiles) {
        return { error: `ai.profiles may not contain more than ${ASSISTANT_PROFILE_LIMITS.profiles} profiles.` }
      }
      const seenIds = new Set<string>()
      const profiles: PersistedAiProfile[] = []
      for (const entry of rawProfiles) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return { error: 'Each ai.profiles entry must be an object.' }
        }
        const raw = entry as Record<string, unknown>
        if (
          !hasOnlyKeys(raw, [
            'id',
            'name',
            'provider',
            'baseUrl',
            'model',
            'models',
            'temperature',
            'topP',
            'maxOutputTokens',
            'enabled',
            'apiKey',
            'backendProfileId',
          ])
        ) {
          return { error: 'Each ai.profiles entry contains an unknown field.' }
        }

        const id = typeof raw.id === 'string' ? raw.id.trim() : ''
        if (!isSafeRecordKey(id, ASSISTANT_PROFILE_LIMITS.idLength)) {
          return {
            error: `Each profile requires a safe non-empty id of at most ${ASSISTANT_PROFILE_LIMITS.idLength} characters.`,
          }
        }
        if (seenIds.has(id)) {
          return { error: `Duplicate profile id: ${id}.` }
        }
        seenIds.add(id)

        const name = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (!name) {
          return { error: `Profile ${id} requires a non-empty name.` }
        }
        if (name.length > ASSISTANT_PROFILE_LIMITS.nameLength) {
          return { error: `Profile ${id} name is too long (max ${ASSISTANT_PROFILE_LIMITS.nameLength}).` }
        }

        const provider = raw.provider
        if (
          typeof provider !== 'string' ||
          !ASSISTANT_PROFILE_PROVIDER_KINDS.includes(provider as AssistantProfileProviderKind)
        ) {
          return {
            error: `Profile ${id} has an invalid provider. Expected one of: ${ASSISTANT_PROFILE_PROVIDER_KINDS.join(', ')}.`,
          }
        }

        if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
          return { error: `Profile ${id} enabled must be a boolean.` }
        }

        const profile: PersistedAiProfile = {
          id,
          name,
          provider: provider as AssistantProfileProviderKind,
          enabled: raw.enabled === undefined ? true : raw.enabled,
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
          const model = raw.model.trim()
          if (!isBoundedString(model, 1, ASSISTANT_PROFILE_LIMITS.modelLength)) {
            return {
              error: `Profile ${id} model may not exceed ${ASSISTANT_PROFILE_LIMITS.modelLength} characters.`,
            }
          }
          profile.model = model
        }

        if (raw.models !== undefined && raw.models !== null) {
          if (
            !Array.isArray(raw.models) ||
            raw.models.length > ASSISTANT_PROFILE_LIMITS.modelCount ||
            raw.models.some((model) => typeof model !== 'string')
          ) {
            return { error: `Profile ${id} models must be an array of strings.` }
          }
          const models = (raw.models as string[]).map((model) => model.trim()).filter((model) => model.length > 0)
          if (
            models.some((model) => !isBoundedString(model, 1, ASSISTANT_PROFILE_LIMITS.modelLength)) ||
            new Set(models).size !== models.length
          ) {
            return {
              error: `Profile ${id} models must be unique strings of at most ${ASSISTANT_PROFILE_LIMITS.modelLength} characters.`,
            }
          }
          if (models.length > 0) {
            profile.models = models
          }
        }

        if (raw.temperature !== undefined && raw.temperature !== null) {
          if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
            return { error: `Profile ${id} temperature must be a number from 0 to 2.` }
          }
          profile.temperature = raw.temperature
        }
        if (raw.topP !== undefined && raw.topP !== null) {
          if (typeof raw.topP !== 'number' || !Number.isFinite(raw.topP) || raw.topP < 0 || raw.topP > 1) {
            return { error: `Profile ${id} topP must be a number from 0 to 1.` }
          }
          profile.topP = raw.topP
        }
        if (raw.maxOutputTokens !== undefined && raw.maxOutputTokens !== null) {
          if (!Number.isSafeInteger(raw.maxOutputTokens) || (raw.maxOutputTokens as number) < 1 || (raw.maxOutputTokens as number) > 200_000) {
            return { error: `Profile ${id} maxOutputTokens must be an integer from 1 to 200000.` }
          }
          profile.maxOutputTokens = raw.maxOutputTokens as number
        }

        // Standard Red Notes: optional reference to a named backend profile. A
        // non-empty string links this assistant profile to that backend; null or
        // '' clears the link (falls back to the embedded provider/key).
        if (raw.backendProfileId !== undefined && raw.backendProfileId !== null && raw.backendProfileId !== '') {
          if (typeof raw.backendProfileId !== 'string') {
            return { error: `Profile ${id} backendProfileId must be a string.` }
          }
          const backendProfileId = raw.backendProfileId.trim()
          if (!isSafeRecordKey(backendProfileId, ASSISTANT_PROFILE_LIMITS.idLength)) {
            return { error: `Profile ${id} backendProfileId is invalid.` }
          }
          profile.backendProfileId = backendProfileId
        }

        // Subscription credentials belong only in the encrypted pairing store.
        // Omission/null/empty clears any legacy plaintext value on save; a new
        // inline value is rejected. For other providers, omission preserves an
        // existing non-subscription key by id.
        if (provider === 'codex-subscription') {
          if (raw.apiKey !== undefined && raw.apiKey !== null && raw.apiKey !== '') {
            return {
              error: `Profile ${id} cannot store a ChatGPT/Codex subscription credential inline. Use subscription pairing.`,
            }
          }
        } else if (raw.apiKey === undefined) {
          const prior = existingById.get(id)
          if (prior?.provider !== 'codex-subscription' && prior?.apiKey) {
            profile.apiKey = prior.apiKey
          }
        } else if (raw.apiKey === null || raw.apiKey === '') {
          // cleared — leave apiKey unset
        } else if (typeof raw.apiKey === 'string') {
          const apiKey = raw.apiKey.trim()
          if (apiKey.length > ASSISTANT_PROFILE_LIMITS.secretLength) {
            return {
              error: `Profile ${id} apiKey may not exceed ${ASSISTANT_PROFILE_LIMITS.secretLength} characters.`,
            }
          }
          profile.apiKey = apiKey || undefined
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
    } else if (
      typeof rawDefaultId === 'string' &&
      isSafeRecordKey(rawDefaultId.trim(), ASSISTANT_PROFILE_LIMITS.idLength)
    ) {
      result.defaultProfileId = rawDefaultId.trim()
    } else {
      return { error: 'ai.defaultProfileId must be a non-empty string, or null to clear it.' }
    }
  }

  return result
}

// ============================================================================
// Standard Red Notes: DECOUPLED "BACKEND PROFILES".
//
// A backend profile is a reusable, named PROVIDER/CONNECTION config, separated
// from the assistant profile that references it. Two kinds:
//   - 'api-key'      : a provider (anthropic | openai-compatible | ollama) with
//                      a base URL / model defaults + a write-only apiKey secret.
//   - 'subscription' : a paired ChatGPT/Codex subscription, named by
//                      subscriptionId (the paired-credential id held server-side).
//
// Assistant profiles reference a backend profile by id (PersistedAiProfile
// .backendProfileId). BACK-COMPAT: a deployment with no explicit backend
// profiles keeps working — the effective set is SYNTHESIZED from the existing
// (embedded) assistant/legacy profiles (see effectiveBackendProfiles), so the
// two-layer view is coherent without a destructive rewrite.
//
// SECRETS: a backend profile's apiKey follows the exact same write-only/masked
// contract as an assistant profile's key — never returned raw, omit-to-preserve
// on resubmit, null to clear.
// ============================================================================

export type BackendProfileType = 'api-key' | 'subscription'

/** The api-key backend providers (subscription backends carry no provider). */
export type BackendApiKeyProvider = 'anthropic' | 'openai-compatible' | 'ollama'

export const BACKEND_API_KEY_PROVIDERS: BackendApiKeyProvider[] = ['anthropic', 'openai-compatible', 'ollama']

/** A backend profile as persisted on disk. May contain the (secret) apiKey. */
export interface PersistedBackendProfile {
  id: string
  name: string
  type: BackendProfileType
  /** api-key backends only: which provider kind this connection targets. */
  provider?: BackendApiKeyProvider
  /** Base URL for openai-compatible / ollama / (optional) subscription endpoints. */
  baseUrl?: string
  /** Default model id used when a referencing profile does not set one. */
  model?: string
  /** Optional cached list of available models. */
  models?: string[]
  /** OpenAI transport contract; subscription backends always resolve to Responses. */
  wireProtocol?: 'chat-completions' | 'responses'
  timeoutMs?: number
  maxRetries?: number
  /** api-key backends: the secret credential. NEVER returned by any endpoint. */
  apiKey?: string
  /** subscription backends: the id of the paired subscription credential. */
  subscriptionId?: string
}

/** A backend profile as returned in the masked admin view (secret -> boolean). */
export interface MaskedBackendProfile {
  id: string
  name: string
  type: BackendProfileType
  provider: BackendApiKeyProvider | null
  baseUrl: string | null
  model: string | null
  models?: string[]
  wireProtocol: 'chat-completions' | 'responses' | null
  timeoutMs: number | null
  maxRetries: number | null
  subscriptionId: string | null
  keyConfigured: boolean
}

/** Masks a persisted backend profile for the admin view (drops the secret). */
export function maskBackendProfile(backend: PersistedBackendProfile): MaskedBackendProfile {
  return {
    id: backend.id,
    name: backend.name,
    type: backend.type,
    provider: backend.provider ?? null,
    baseUrl: backend.baseUrl ?? null,
    model: backend.model ?? null,
    ...(backend.models && backend.models.length > 0 ? { models: backend.models } : {}),
    wireProtocol: backend.type === 'subscription' ? 'responses' : (backend.wireProtocol ?? null),
    timeoutMs: backend.timeoutMs ?? null,
    maxRetries: backend.maxRetries ?? null,
    subscriptionId: backend.subscriptionId ?? null,
    keyConfigured: Boolean(backend.apiKey),
  }
}

export function maskBackendProfiles(backends: PersistedBackendProfile[]): MaskedBackendProfile[] {
  return backends.map(maskBackendProfile)
}

/**
 * Synthesize a backend profile from an (embedded) assistant/legacy profile — the
 * migration bridge that lets a deployment with no explicit backend profiles still
 * present a coherent two-layer model. A codex-subscription profile becomes a
 * subscription backend (default subscription id); everything else an api-key
 * backend carrying the profile's provider/URL/model/key.
 */
export function backendProfileFromAssistantProfile(profile: PersistedAiProfile): PersistedBackendProfile {
  if (profile.provider === 'codex-subscription') {
    return {
      id: `backend-of-${profile.id}`,
      name: profile.name,
      type: 'subscription',
      baseUrl: profile.baseUrl,
      model: profile.model,
      wireProtocol: 'responses',
      subscriptionId: profile.subscriptionId ?? DEFAULT_SUBSCRIPTION_ID,
    }
  }
  return {
    id: `backend-of-${profile.id}`,
    name: profile.name,
    type: 'api-key',
    provider: (profile.provider === 'anthropic' || profile.provider === 'ollama'
      ? profile.provider
      : 'openai-compatible') as BackendApiKeyProvider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    ...(profile.models && profile.models.length > 0 ? { models: profile.models } : {}),
    apiKey: profile.apiKey,
  }
}

/** The reserved id of the first/legacy paired subscription credential. */
export const DEFAULT_SUBSCRIPTION_ID = 'default'

/**
 * The effective backend-profile set: explicit persisted backend profiles win;
 * otherwise they are synthesized from the effective assistant profiles so an
 * existing (embedded-only) deployment resolves unchanged. Pure — no I/O.
 */
export function effectiveBackendProfiles(
  persisted: PersistedBackendProfile[] | undefined,
  assistantProfiles: PersistedAiProfile[],
): PersistedBackendProfile[] {
  if (persisted && persisted.length > 0) {
    return persisted
  }
  return assistantProfiles.map(backendProfileFromAssistantProfile)
}

/**
 * Merge a referenced backend profile onto an assistant profile, producing a
 * self-contained PersistedAiProfile the existing resolveProfileProvider consumes.
 * A profile with no reference is returned unchanged for legacy embedded
 * behavior. A missing explicit reference fails closed so stale configuration
 * can never silently fall back to embedded credentials. A subscription backend
 * maps to the codex-subscription provider and carries the subscriptionId through
 * so the proxy can draw a fresh token for THAT paired subscription.
 */
export function resolveEffectiveAssistantProfile(
  profile: PersistedAiProfile,
  backendProfiles: PersistedBackendProfile[],
): PersistedAiProfile {
  if (!profile.backendProfileId) {
    if (profile.provider === 'codex-subscription') {
      const subscriptionId = profile.subscriptionId ?? DEFAULT_SUBSCRIPTION_ID
      if (!isValidSubscriptionId(subscriptionId)) {
        throw new Error('The subscription backend identifier is invalid.')
      }
      return {
        ...profile,
        apiKey: undefined,
        subscriptionId,
      }
    }
    return profile
  }
  const backend = backendProfiles.find((candidate) => candidate.id === profile.backendProfileId)
  if (!backend) {
    throw new Error('Referenced assistant backend profile is unavailable.')
  }
  if (backend.type === 'subscription') {
    const subscriptionId = backend.subscriptionId ?? DEFAULT_SUBSCRIPTION_ID
    if (!isValidSubscriptionId(subscriptionId)) {
      throw new Error('The subscription backend identifier is invalid.')
    }
    return {
      ...profile,
      provider: 'codex-subscription',
      baseUrl: backend.baseUrl ?? profile.baseUrl,
      model: profile.model ?? backend.model,
      apiKey: undefined,
      subscriptionId,
      wireProtocol: 'responses',
      timeoutMs: backend.timeoutMs,
      maxRetries: backend.maxRetries,
    }
  }
  return {
    ...profile,
    provider: (backend.provider ?? profile.provider) as AssistantProfileProviderKind,
    baseUrl: backend.baseUrl ?? profile.baseUrl,
    model: profile.model ?? backend.model,
    models: backend.models ?? profile.models,
    apiKey: backend.apiKey,
    wireProtocol: backend.wireProtocol,
    timeoutMs: backend.timeoutMs,
    maxRetries: backend.maxRetries,
  }
}

// ============================================================================
// Standard Red Notes: ASSISTANT-PROFILE ASSIGNMENTS (user / role).
//
// Maps a requesting principal to the assistant profile that should serve them.
// Precedence at request time: USER assignment > ROLE assignment > server default
// (see resolveAssignedProfileId). User keys are lowercased identifiers (uuid or
// email); role keys are canonical role names.
// ============================================================================

export interface AssistantProfileAssignments {
  /** lowercased user identifier (uuid or email) -> assistant profile id. */
  users: Record<string, string>
  /** canonical role name -> assistant profile id. */
  roles: Record<string, string>
}

/** The four canonical roles an admin may assign a profile to. */
export const ASSIGNABLE_ROLE_NAMES = ['ADMIN_USER', 'PRO_USER', 'CORE_USER', 'VAULTS_USER'] as const
export type AssignableRoleName = (typeof ASSIGNABLE_ROLE_NAMES)[number]

/**
 * Resolve the effective assistant-profile id for a principal: the first USER
 * identifier with an assignment to an existing enabled profile wins, else the
 * first matching ROLE assignment, else the server default. Stale assignments
 * (pointing at a removed/disabled profile) are ignored so resolution never dead-
 * ends. Pure — no I/O.
 */
export function resolveAssignedProfileId(
  assignments: AssistantProfileAssignments | undefined,
  defaultProfileId: string | undefined,
  userIdentifiers: string[],
  roleNames: string[],
  profiles: PersistedAiProfile[],
): string | undefined {
  const isUsable = (id: string | undefined): id is string =>
    typeof id === 'string' && profiles.some((profile) => profile.id === id && profile.enabled)

  if (assignments) {
    for (const identifier of userIdentifiers) {
      const id = assignments.users?.[identifier.toLowerCase()]
      if (isUsable(id)) {
        return id
      }
    }
    for (const role of roleNames) {
      const id = assignments.roles?.[role]
      if (isUsable(id)) {
        return id
      }
    }
  }

  return defaultProfileId
}

// ---------------------------------------------------------------------------
// Validation of PUT payloads for the new sections.
// ---------------------------------------------------------------------------

export type BackendProfilesValidation = { backendProfiles?: PersistedBackendProfile[] | null } | { error: string }

/**
 * Validates the `backendProfiles` array from a PUT body. `null` clears the
 * persisted value (falls back to synthesized). Each entry: id + name required,
 * type must be 'api-key' | 'subscription'; api-key requires a known provider and
 * (optional) http(s) baseUrl; subscription requires a subscriptionId. Secret
 * handling mirrors assistant profiles: apiKey undefined => preserve existing (by
 * id); null/'' => clear; non-empty string => set.
 */
export function validateBackendProfilesPatch(
  rawBackends: unknown,
  existing: PersistedBackendProfile[] | undefined,
): BackendProfilesValidation {
  if (rawBackends === undefined) {
    return {}
  }
  if (rawBackends === null) {
    return { backendProfiles: null }
  }
  if (!Array.isArray(rawBackends)) {
    return { error: 'ai.backendProfiles must be an array, or null to clear it.' }
  }
  if (rawBackends.length > ASSISTANT_PROFILE_LIMITS.profiles) {
    return { error: `ai.backendProfiles may not contain more than ${ASSISTANT_PROFILE_LIMITS.profiles} entries.` }
  }

  const existingById = new Map((existing ?? []).map((backend) => [backend.id, backend]))
  const seenIds = new Set<string>()
  const backends: PersistedBackendProfile[] = []

  for (const entry of rawBackends) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'Each ai.backendProfiles entry must be an object.' }
    }
    const raw = entry as Record<string, unknown>
    if (
      !hasOnlyKeys(raw, [
        'id',
        'name',
        'type',
        'provider',
        'baseUrl',
        'model',
        'models',
        'apiKey',
        'subscriptionId',
        'wireProtocol',
        'timeoutMs',
        'maxRetries',
      ])
    ) {
      return { error: 'Each ai.backendProfiles entry contains an unknown field.' }
    }

    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!isSafeRecordKey(id, ASSISTANT_PROFILE_LIMITS.idLength)) {
      return {
        error: `Each backend profile requires a safe non-empty id of at most ${ASSISTANT_PROFILE_LIMITS.idLength} characters.`,
      }
    }
    if (seenIds.has(id)) {
      return { error: `Duplicate backend profile id: ${id}.` }
    }
    seenIds.add(id)

    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) {
      return { error: `Backend profile ${id} requires a non-empty name.` }
    }
    if (name.length > ASSISTANT_PROFILE_LIMITS.nameLength) {
      return { error: `Backend profile ${id} name is too long (max ${ASSISTANT_PROFILE_LIMITS.nameLength}).` }
    }

    if (raw.type !== 'api-key' && raw.type !== 'subscription') {
      return { error: `Backend profile ${id} type must be 'api-key' or 'subscription'.` }
    }
    const type = raw.type as BackendProfileType

    const backend: PersistedBackendProfile = { id, name, type }

    if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
      if (typeof raw.baseUrl !== 'string' || !isHttpUrl(raw.baseUrl.trim())) {
        return { error: `Backend profile ${id} baseUrl must be an http(s) URL.` }
      }
      backend.baseUrl = raw.baseUrl.trim()
    }
    if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
      if (typeof raw.model !== 'string') {
        return { error: `Backend profile ${id} model must be a string.` }
      }
      const model = raw.model.trim()
      if (!isBoundedString(model, 1, ASSISTANT_PROFILE_LIMITS.modelLength)) {
        return {
          error: `Backend profile ${id} model may not exceed ${ASSISTANT_PROFILE_LIMITS.modelLength} characters.`,
        }
      }
      backend.model = model
    }
    if (raw.models !== undefined && raw.models !== null) {
      if (
        !Array.isArray(raw.models) ||
        raw.models.length > ASSISTANT_PROFILE_LIMITS.modelCount ||
        raw.models.some((model) => typeof model !== 'string')
      ) {
        return { error: `Backend profile ${id} models must be an array of strings.` }
      }
      const models = (raw.models as string[]).map((model) => model.trim()).filter((model) => model.length > 0)
      if (
        models.some((model) => !isBoundedString(model, 1, ASSISTANT_PROFILE_LIMITS.modelLength)) ||
        new Set(models).size !== models.length
      ) {
        return {
          error: `Backend profile ${id} models must be unique strings of at most ${ASSISTANT_PROFILE_LIMITS.modelLength} characters.`,
        }
      }
      if (models.length > 0) {
        backend.models = models
      }
    }
    if (raw.wireProtocol !== undefined && raw.wireProtocol !== null) {
      if (raw.wireProtocol !== 'chat-completions' && raw.wireProtocol !== 'responses') {
        return { error: `Backend profile ${id} wireProtocol must be 'chat-completions' or 'responses'.` }
      }
      backend.wireProtocol = raw.wireProtocol
    }
    if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
      if (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1_000 || (raw.timeoutMs as number) > 600_000) {
        return { error: `Backend profile ${id} timeoutMs must be an integer from 1000 to 600000.` }
      }
      backend.timeoutMs = raw.timeoutMs as number
    }
    if (raw.maxRetries !== undefined && raw.maxRetries !== null) {
      if (!Number.isSafeInteger(raw.maxRetries) || (raw.maxRetries as number) < 0 || (raw.maxRetries as number) > 10) {
        return { error: `Backend profile ${id} maxRetries must be an integer from 0 to 10.` }
      }
      backend.maxRetries = raw.maxRetries as number
    }

    if (type === 'api-key') {
      const provider = raw.provider
      if (typeof provider !== 'string' || !BACKEND_API_KEY_PROVIDERS.includes(provider as BackendApiKeyProvider)) {
        return {
          error: `Backend profile ${id} has an invalid provider. Expected one of: ${BACKEND_API_KEY_PROVIDERS.join(', ')}.`,
        }
      }
      backend.provider = provider as BackendApiKeyProvider

      if (backend.wireProtocol && backend.provider !== 'openai-compatible') {
        return { error: `Backend profile ${id} wireProtocol is only valid for openai-compatible providers.` }
      }

      if (raw.apiKey === undefined) {
        const prior = existingById.get(id)
        if (prior?.apiKey) {
          backend.apiKey = prior.apiKey
        }
      } else if (raw.apiKey === null || raw.apiKey === '') {
        // cleared — leave apiKey unset
      } else if (typeof raw.apiKey === 'string') {
        const apiKey = raw.apiKey.trim()
        if (apiKey.length > ASSISTANT_PROFILE_LIMITS.secretLength) {
          return {
            error: `Backend profile ${id} apiKey may not exceed ${ASSISTANT_PROFILE_LIMITS.secretLength} characters.`,
          }
        }
        backend.apiKey = apiKey || undefined
      } else {
        return { error: `Backend profile ${id} apiKey must be a string, null, or omitted.` }
      }
    } else {
      const subscriptionId = typeof raw.subscriptionId === 'string' ? raw.subscriptionId : ''
      if (!subscriptionId) {
        return { error: `Backend profile ${id} (subscription) requires a subscriptionId.` }
      }
      if (!isValidSubscriptionId(subscriptionId)) {
        return { error: `Backend profile ${id} has an invalid subscriptionId.` }
      }
      backend.subscriptionId = subscriptionId
      backend.wireProtocol = 'responses'
    }

    backends.push(backend)
  }

  return { backendProfiles: backends }
}

export type AssignmentsValidation = { assignments?: AssistantProfileAssignments | null } | { error: string }

/**
 * Validates an `assignments` object: `{ users?: Record<id,profileId>, roles?:
 * Record<roleName,profileId> }`. `null` clears the whole mapping. User keys are
 * arbitrary non-empty identifiers (lowercased); role keys must be canonical role
 * names. Values must be non-empty profile-id strings. Empty maps are normalized.
 */
export function validateAssignmentsPatch(rawAssignments: unknown): AssignmentsValidation {
  if (rawAssignments === undefined) {
    return {}
  }
  if (rawAssignments === null) {
    return { assignments: null }
  }
  if (!hasOnlyKeys(rawAssignments, ['users', 'roles'])) {
    return { error: 'ai.assignments must be an object, or null to clear it.' }
  }

  const raw = rawAssignments
  const users: Record<string, string> = {}
  const roles: Record<string, string> = {}

  if (raw.users !== undefined && raw.users !== null) {
    if (typeof raw.users !== 'object' || Array.isArray(raw.users)) {
      return { error: 'ai.assignments.users must be an object of identifier -> profile id.' }
    }
    const entries = Object.entries(raw.users as Record<string, unknown>)
    if (entries.length > ASSISTANT_PROFILE_LIMITS.assignmentCount) {
      return {
        error: `ai.assignments.users may not contain more than ${ASSISTANT_PROFILE_LIMITS.assignmentCount} entries.`,
      }
    }
    for (const [identifier, value] of entries) {
      const key = identifier.trim().toLowerCase()
      if (!isSafeRecordKey(key, ASSISTANT_PROFILE_LIMITS.userIdentifierLength)) {
        return { error: 'ai.assignments.users has an empty identifier key or an unsafe identifier.' }
      }
      if (typeof value !== 'string' || !isSafeRecordKey(value.trim(), ASSISTANT_PROFILE_LIMITS.idLength)) {
        return { error: `ai.assignments.users[${identifier}] must be a non-empty profile id.` }
      }
      users[key] = value.trim()
    }
  }

  if (raw.roles !== undefined && raw.roles !== null) {
    if (typeof raw.roles !== 'object' || Array.isArray(raw.roles)) {
      return { error: 'ai.assignments.roles must be an object of role name -> profile id.' }
    }
    for (const [roleName, value] of Object.entries(raw.roles as Record<string, unknown>)) {
      if (!ASSIGNABLE_ROLE_NAMES.includes(roleName as AssignableRoleName)) {
        return {
          error: `ai.assignments.roles has an unknown role "${roleName}". Expected one of: ${ASSIGNABLE_ROLE_NAMES.join(', ')}.`,
        }
      }
      if (typeof value !== 'string' || !isSafeRecordKey(value.trim(), ASSISTANT_PROFILE_LIMITS.idLength)) {
        return { error: `ai.assignments.roles[${roleName}] must be a non-empty profile id.` }
      }
      roles[roleName] = value.trim()
    }
  }

  return { assignments: { users, roles } }
}
