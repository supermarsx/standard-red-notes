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

        // Standard Red Notes: optional reference to a named backend profile. A
        // non-empty string links this assistant profile to that backend; null or
        // '' clears the link (falls back to the embedded provider/key).
        if (raw.backendProfileId !== undefined && raw.backendProfileId !== null && raw.backendProfileId !== '') {
          if (typeof raw.backendProfileId !== 'string') {
            return { error: `Profile ${id} backendProfileId must be a string.` }
          }
          profile.backendProfileId = raw.backendProfileId.trim()
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
 * When the profile references no backend (or the backend is missing) it is
 * returned unchanged (legacy embedded behavior). A subscription backend maps to
 * the codex-subscription provider and carries the subscriptionId through so the
 * proxy can draw a fresh token for THAT paired subscription.
 */
export function resolveEffectiveAssistantProfile(
  profile: PersistedAiProfile,
  backendProfiles: PersistedBackendProfile[],
): PersistedAiProfile {
  if (!profile.backendProfileId) {
    return profile
  }
  const backend = backendProfiles.find((candidate) => candidate.id === profile.backendProfileId)
  if (!backend) {
    return profile
  }
  if (backend.type === 'subscription') {
    return {
      ...profile,
      provider: 'codex-subscription',
      baseUrl: backend.baseUrl ?? profile.baseUrl,
      model: profile.model ?? backend.model,
      apiKey: undefined,
      subscriptionId: backend.subscriptionId ?? DEFAULT_SUBSCRIPTION_ID,
    }
  }
  return {
    ...profile,
    provider: (backend.provider ?? profile.provider) as AssistantProfileProviderKind,
    baseUrl: backend.baseUrl ?? profile.baseUrl,
    model: profile.model ?? backend.model,
    models: backend.models ?? profile.models,
    apiKey: backend.apiKey,
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
export const ASSIGNABLE_ROLE_NAMES = ['INTERNAL_TEAM_USER', 'PRO_USER', 'CORE_USER', 'VAULTS_USER'] as const
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

export type BackendProfilesValidation =
  | { backendProfiles?: PersistedBackendProfile[] | null }
  | { error: string }

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
  if (rawBackends.length > MAX_PROFILES) {
    return { error: `ai.backendProfiles may not contain more than ${MAX_PROFILES} entries.` }
  }

  const existingById = new Map((existing ?? []).map((backend) => [backend.id, backend]))
  const seenIds = new Set<string>()
  const backends: PersistedBackendProfile[] = []

  for (const entry of rawBackends) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'Each ai.backendProfiles entry must be an object.' }
    }
    const raw = entry as Record<string, unknown>

    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id) {
      return { error: 'Each backend profile requires a non-empty string id.' }
    }
    if (seenIds.has(id)) {
      return { error: `Duplicate backend profile id: ${id}.` }
    }
    seenIds.add(id)

    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) {
      return { error: `Backend profile ${id} requires a non-empty name.` }
    }
    if (name.length > MAX_NAME_LENGTH) {
      return { error: `Backend profile ${id} name is too long (max ${MAX_NAME_LENGTH}).` }
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
      backend.model = raw.model.trim()
    }
    if (raw.models !== undefined && raw.models !== null) {
      if (!Array.isArray(raw.models) || raw.models.some((model) => typeof model !== 'string')) {
        return { error: `Backend profile ${id} models must be an array of strings.` }
      }
      const models = (raw.models as string[]).map((model) => model.trim()).filter((model) => model.length > 0)
      if (models.length > 0) {
        backend.models = models
      }
    }

    if (type === 'api-key') {
      const provider = raw.provider
      if (typeof provider !== 'string' || !BACKEND_API_KEY_PROVIDERS.includes(provider as BackendApiKeyProvider)) {
        return {
          error: `Backend profile ${id} has an invalid provider. Expected one of: ${BACKEND_API_KEY_PROVIDERS.join(', ')}.`,
        }
      }
      backend.provider = provider as BackendApiKeyProvider

      if (raw.apiKey === undefined) {
        const prior = existingById.get(id)
        if (prior?.apiKey) {
          backend.apiKey = prior.apiKey
        }
      } else if (raw.apiKey === null || raw.apiKey === '') {
        // cleared — leave apiKey unset
      } else if (typeof raw.apiKey === 'string') {
        backend.apiKey = raw.apiKey.trim() || undefined
      } else {
        return { error: `Backend profile ${id} apiKey must be a string, null, or omitted.` }
      }
    } else {
      const subscriptionId = typeof raw.subscriptionId === 'string' ? raw.subscriptionId.trim() : ''
      if (!subscriptionId) {
        return { error: `Backend profile ${id} (subscription) requires a subscriptionId.` }
      }
      backend.subscriptionId = subscriptionId
    }

    backends.push(backend)
  }

  return { backendProfiles: backends }
}

export type AssignmentsValidation =
  | { assignments?: AssistantProfileAssignments | null }
  | { error: string }

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
  if (typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) {
    return { error: 'ai.assignments must be an object, or null to clear it.' }
  }

  const raw = rawAssignments as Record<string, unknown>
  const users: Record<string, string> = {}
  const roles: Record<string, string> = {}

  if (raw.users !== undefined && raw.users !== null) {
    if (typeof raw.users !== 'object' || Array.isArray(raw.users)) {
      return { error: 'ai.assignments.users must be an object of identifier -> profile id.' }
    }
    for (const [identifier, value] of Object.entries(raw.users as Record<string, unknown>)) {
      const key = identifier.trim().toLowerCase()
      if (!key) {
        return { error: 'ai.assignments.users has an empty identifier key.' }
      }
      if (typeof value !== 'string' || value.trim() === '') {
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
      if (typeof value !== 'string' || value.trim() === '') {
        return { error: `ai.assignments.roles[${roleName}] must be a non-empty profile id.` }
      }
      roles[roleName] = value.trim()
    }
  }

  return { assignments: { users, roles } }
}
