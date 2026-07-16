// Data-driven OpenAI-compatible provider PRESETS.
//
// Every preset is a thin id -> { baseURL, key-source, header/model-path quirk }
// mapping over the existing OpenAI-compatible request path (see openaiAuth.ts /
// openai.ts). Adding a provider is a one-line table entry; no new streaming code
// is required because the wire format is the OpenAI Chat Completions schema.
//
// Keys stay SERVER-HELD. Per-preset credentials/base URLs are sourced directly
// from the environment at resolution time (injectable for tests) so this module
// stays off the DI-env / Container.ts path. Every default below is
// env-overridable via ASSISTANT_PRESET_<ID>_{BASE_URL,API_KEY,MODEL} where <ID>
// is the preset id uppercased with every non-alphanumeric character replaced by
// '_' (e.g. `azure-openai` -> `AZURE_OPENAI`, `google-openai` -> `GOOGLE_OPENAI`).
//
// keep in sync with web providerCatalog.ts

/** Environment map this module reads (defaults to process.env, overridable in tests). */
type Env = Record<string, string | undefined>

/**
 * Static description of one OpenAI-compatible upstream. Quirks (Azure's
 * `api-key` header + `api-version` query, non-default model-list paths) are
 * expressed declaratively so the resolver stays generic.
 */
export interface OpenAiCompatiblePreset {
  /** Stable id used on the wire (`?provider=<id>`). */
  id: string
  /** Human-readable label for the client catalog. */
  label: string
  /**
   * Default base URL. Absent for deployment-scoped / bring-your-own upstreams
   * (azure-openai, custom) whose base URL MUST come from env.
   */
  defaultBaseURL?: string
  /** Whether an API key is required to consider this preset usable. */
  keyRequired: boolean
  /** Model-discovery path relative to the base URL. Defaults to `/models`. */
  modelsPath?: string
  /**
   * How the key is presented upstream. `bearer` -> `Authorization: Bearer <key>`
   * (default); `api-key` -> `api-key: <key>` header (Azure).
   */
  authHeader?: 'bearer' | 'api-key'
  /** API version appended as `?api-version=` for deployment-based upstreams (Azure). */
  apiVersion?: string
  /** Extra static headers merged onto every upstream request. */
  defaultHeaders?: Record<string, string>
  /** Operator-facing note surfaced in the client catalog. */
  notes?: string
}

/** Default model-discovery path when a preset does not override it. */
const DEFAULT_MODELS_PATH = '/models'

/**
 * The preset table. Keyed by id. Add a provider by adding one entry here (and
 * the mirrored entry in web providerCatalog.ts).
 */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, OpenAiCompatiblePreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    keyRequired: true,
    notes: 'Falls back to the generic ASSISTANT_OPENAI_API_KEY if no preset-specific key is set.',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    keyRequired: true,
  },
  together: {
    id: 'together',
    label: 'Together',
    defaultBaseURL: 'https://api.together.xyz/v1',
    keyRequired: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    keyRequired: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    keyRequired: true,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    keyRequired: true,
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    defaultBaseURL: 'https://api.perplexity.ai',
    keyRequired: true,
    notes: '/models may return 404; model discovery is best-effort and falls back to a free-text model field.',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    defaultBaseURL: 'https://api.x.ai/v1',
    keyRequired: true,
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks',
    defaultBaseURL: 'https://api.fireworks.ai/inference/v1',
    keyRequired: true,
  },
  'google-openai': {
    id: 'google-openai',
    label: 'Google Gemini (OpenAI-compatible)',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRequired: true,
  },
  'azure-openai': {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    // Deployment-scoped: base URL is fully operator-provided
    // (https://<resource>.openai.azure.com/openai/deployments/<deployment>).
    keyRequired: true,
    modelsPath: '/openai/deployments',
    authHeader: 'api-key',
    apiVersion: '2024-10-21',
    notes:
      'Deployment-based. Set ASSISTANT_PRESET_AZURE_OPENAI_BASE_URL and ' +
      'ASSISTANT_PRESET_AZURE_OPENAI_API_VERSION. Auth uses the `api-key` header; every call needs `?api-version=`.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseURL: 'http://localhost:1234/v1',
    keyRequired: false,
  },
  'ollama-openai': {
    id: 'ollama-openai',
    label: 'Ollama (OpenAI-compatible)',
    defaultBaseURL: 'http://localhost:11434/v1',
    keyRequired: false,
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    // Bring-your-own: base URL from env; passthrough.
    keyRequired: false,
    notes: 'Point ASSISTANT_PRESET_CUSTOM_BASE_URL at any OpenAI-compatible server.',
  },
}

/** Fully-resolved upstream connection parameters for an OpenAI-compatible preset. */
export interface ResolvedPresetUpstream {
  baseURL: string
  /** API key used only to authenticate the upstream call; never returned to clients. */
  apiKey: string
  /** Extra static headers merged onto every upstream request. */
  defaultHeaders: Record<string, string>
  /** Model-discovery path (already includes `?api-version=` for Azure). */
  modelsPath: string
  /** How the key is presented upstream: `bearer` or Azure's `api-key` header. */
  authHeader: 'bearer' | 'api-key'
}

/** Looks up a preset by id. */
export function getPreset(id: string): OpenAiCompatiblePreset | undefined {
  return OPENAI_COMPATIBLE_PRESETS[id]
}

/**
 * Env key suffix for a preset id: uppercased, every non-alphanumeric character
 * replaced by `_` (e.g. `azure-openai` -> `AZURE_OPENAI`).
 */
function envIdOf(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/** Reads `ASSISTANT_PRESET_<ID>_<SUFFIX>` from the env map. */
function presetEnv(env: Env, id: string, suffix: string): string | undefined {
  const value = env[`ASSISTANT_PRESET_${envIdOf(id)}_${suffix}`]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Resolves the upstream connection parameters for a preset, applying env
 * overrides. Pure over the passed env (unit-testable). Returns null when a
 * required base URL (azure-openai / custom, which have no default) is missing.
 * API keys are read here for upstream auth only and are never exposed to clients.
 */
export function resolvePresetUpstream(id: string, env: Env = process.env): ResolvedPresetUpstream | null {
  const preset = getPreset(id)
  if (!preset) {
    return null
  }

  const baseURL = presetEnv(env, id, 'BASE_URL') ?? preset.defaultBaseURL
  if (!baseURL) {
    // Deployment-scoped / bring-your-own presets with no base URL are simply
    // "not configured" (clean null, not an error).
    return null
  }

  let apiKey = presetEnv(env, id, 'API_KEY') ?? ''
  // The `openai` preset falls back to the generic ASSISTANT_OPENAI_API_KEY so it
  // shares credentials with the pre-existing OpenAI-compatible path.
  if (!apiKey && id === 'openai') {
    apiKey = (env.ASSISTANT_OPENAI_API_KEY ?? '').trim()
  }

  const authHeader = preset.authHeader ?? 'bearer'
  const defaultHeaders: Record<string, string> = { ...(preset.defaultHeaders ?? {}) }

  let modelsPath = preset.modelsPath ?? DEFAULT_MODELS_PATH
  // Azure (and any api-key/apiVersion preset) appends the required api-version
  // query to the discovery path; every request is version-scoped.
  const apiVersion = presetEnv(env, id, 'API_VERSION') ?? preset.apiVersion
  if (apiVersion) {
    const sep = modelsPath.includes('?') ? '&' : '?'
    modelsPath = `${modelsPath}${sep}api-version=${encodeURIComponent(apiVersion)}`
  }

  return { baseURL, apiKey, defaultHeaders, modelsPath, authHeader }
}

/**
 * The preset ids that are usable with the current env: their key is present, OR
 * they are keyless local servers (keyRequired === false), OR their base URL is
 * explicitly set via env. Keys themselves are NEVER included.
 */
export function configuredPresetIds(env: Env = process.env): string[] {
  const ids: string[] = []
  for (const preset of Object.values(OPENAI_COMPATIBLE_PRESETS)) {
    const upstream = resolvePresetUpstream(preset.id, env)
    if (!upstream) {
      // Missing required base URL -> not configured.
      continue
    }
    const baseUrlSetViaEnv = presetEnv(env, preset.id, 'BASE_URL') !== undefined
    if (!preset.keyRequired || upstream.apiKey || baseUrlSetViaEnv) {
      ids.push(preset.id)
    }
  }
  return ids
}

/**
 * Best-effort model discovery for a preset. Queries `baseURL + modelsPath` with
 * the correct auth header (bearer, or Azure's `api-key`), parses the standard
 * `{ data: [{ id }] }` shape (Azure deployments may use `{ data: [{ name }] }`),
 * and NEVER throws — any failure yields `[]` so the client falls back to a
 * free-text model field. The key is used only to authenticate and is never
 * returned or logged.
 */
export async function listPresetModels(id: string, env: Env = process.env): Promise<string[]> {
  try {
    const upstream = resolvePresetUpstream(id, env)
    if (!upstream) {
      return []
    }

    const headers: Record<string, string> = { ...upstream.defaultHeaders }
    if (upstream.apiKey) {
      if (upstream.authHeader === 'api-key') {
        headers['api-key'] = upstream.apiKey
      } else {
        headers['Authorization'] = `Bearer ${upstream.apiKey}`
      }
    }

    const url = `${upstream.baseURL.replace(/\/$/, '')}${upstream.modelsPath}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      return []
    }

    const json = (await res.json()) as { data?: Array<{ id?: string; name?: string }> }
    return (json.data ?? []).map((entry) => entry.id ?? entry.name).filter((value): value is string => Boolean(value))
  } catch {
    return []
  }
}
