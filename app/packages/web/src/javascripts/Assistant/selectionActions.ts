import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { DirectProvider } from './DirectProvider'
import { ProxyProvider } from './ProxyProvider'
import { Provider } from './types'
import { composeSystemPromptWithPersona, getActiveProfile } from './personaSettings'
import { loadSamplingSettings, SamplingSettings } from './samplingSettings'

export type BuiltInSelectionActionId = 'ask' | 'refine' | 'summarize' | 'expand' | 'translate'

/**
 * An action id is one of the fixed built-ins or any string a user gives to a
 * custom action. Built-in ids are reserved and cannot be reused by custom
 * actions (see {@link CUSTOM_ACTION_ID_PREFIX}).
 */
export type SelectionActionId = string

export type SelectionAction = {
  id: SelectionActionId
  label: string
  icon: string
  enabled: boolean
  /** Instruction applied to the selected text. */
  prompt: string
  /** True for actions that take a user-typed instruction (Ask AI). */
  freeform?: boolean
  /**
   * True for actions that need a target LANGUAGE picked at run time (Translate).
   * The chosen language is interpolated into the prompt via the `{language}`
   * placeholder, or appended if the template has no placeholder.
   */
  needsLanguage?: boolean
  /** True for user-created actions (vs the immutable built-in set). */
  custom?: boolean
}

/** Prefix every user-created action id carries, so it can never collide with a built-in. */
export const CUSTOM_ACTION_ID_PREFIX = 'custom:'

/** Default icon used by custom actions when the user doesn't pick one. */
export const DEFAULT_CUSTOM_ACTION_ICON = 'dashboard'

const SYSTEM_PROMPT =
  'You are a writing assistant embedded in a note editor. Apply the requested transformation to the ' +
  "user's text and reply with ONLY the resulting text — no preamble, no explanation, and no markdown " +
  'code fences unless the text itself is code.'

export const DEFAULT_SELECTION_ACTIONS: SelectionAction[] = [
  { id: 'ask', label: 'Ask AI…', icon: 'dashboard', enabled: true, freeform: true, prompt: '' },
  {
    id: 'refine',
    label: 'Refine',
    icon: 'pencil-filled',
    enabled: true,
    prompt: 'Improve the clarity, grammar, and flow of the following text while preserving its meaning and tone.',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    icon: 'list-bulleted',
    enabled: true,
    prompt: 'Summarize the following text concisely.',
  },
  {
    id: 'expand',
    label: 'Expand',
    icon: 'add',
    enabled: true,
    prompt: 'Expand on the following text, adding helpful detail while keeping the same voice and intent.',
  },
  {
    id: 'translate',
    label: 'Translate…',
    icon: 'comment',
    enabled: true,
    needsLanguage: true,
    prompt:
      'Translate the following text into {language}. Preserve meaning, tone, formatting, and any names or code. ' +
      'Reply with ONLY the translation.',
  },
]

/** Placeholder replaced by the chosen target language in a translate prompt. */
export const LANGUAGE_PLACEHOLDER = '{language}'

/**
 * Build the final instruction for a translate action: substitute the chosen
 * language into the template's {language} placeholder, or append it if the
 * (user-edited) template omits the placeholder.
 */
export function buildTranslateInstruction(promptTemplate: string, language: string): string {
  const lang = language.trim()
  const template = promptTemplate.trim()
  if (template.includes(LANGUAGE_PLACEHOLDER)) {
    return template.split(LANGUAGE_PLACEHOLDER).join(lang)
  }
  return `${template} Target language: ${lang}.`
}

/** Override applied to a built-in action (enabled/prompt only — label/icon are fixed). */
type BuiltInOverride = { enabled?: boolean; prompt?: string }

/** A user-defined custom action stored verbatim in the pref. */
type CustomActionRecord = {
  id: string
  label: string
  prompt: string
  enabled?: boolean
  icon?: string
  needsLanguage?: boolean
}

/**
 * Shape of the AssistantSelectionActions preference. Two complementary parts:
 *  - `overrides`: per built-in id, the user's enabled/prompt edits.
 *  - `custom`: an ordered list of fully user-defined actions.
 * The legacy shape was a bare `Record<builtInId, override>` map; that is still
 * accepted (treated as `overrides`) so existing prefs keep working.
 */
type SelectionActionsPref = {
  overrides?: Partial<Record<BuiltInSelectionActionId, BuiltInOverride>>
  custom?: CustomActionRecord[]
}

const BUILT_IN_IDS = new Set<string>(DEFAULT_SELECTION_ACTIONS.map((action) => action.id))

function parseSelectionActionsPref(raw: string): SelectionActionsPref {
  if (!raw) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const obj = parsed as Record<string, unknown>
  // New shape: { overrides, custom }.
  if ('overrides' in obj || 'custom' in obj) {
    const overrides = (obj.overrides as SelectionActionsPref['overrides']) ?? {}
    const custom = Array.isArray(obj.custom) ? (obj.custom as CustomActionRecord[]) : []
    return { overrides, custom }
  }
  // Legacy shape: a bare built-in override map.
  return { overrides: obj as SelectionActionsPref['overrides'], custom: [] }
}

/** Coerce a stored custom record into a valid SelectionAction, dropping unusable ones. */
function normalizeCustomAction(record: CustomActionRecord): SelectionAction | null {
  if (!record || typeof record !== 'object') {
    return null
  }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  // A custom id must be non-empty, prefixed, and must not shadow a built-in.
  if (!id || !id.startsWith(CUSTOM_ACTION_ID_PREFIX) || BUILT_IN_IDS.has(id)) {
    return null
  }
  const prompt = typeof record.prompt === 'string' ? record.prompt : ''
  const label = (typeof record.label === 'string' && record.label.trim()) || 'Custom action'
  return {
    id,
    label,
    icon: (typeof record.icon === 'string' && record.icon.trim()) || DEFAULT_CUSTOM_ACTION_ICON,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    prompt,
    needsLanguage: record.needsLanguage === true,
    custom: true,
  }
}

/**
 * Effective selection actions: the built-in defaults (which a server may override
 * via the assistant config) overlaid with the user's per-action overrides, FOLLOWED
 * by any user-defined custom actions (in their stored order).
 */
export function getSelectionActions(application: WebApplication): SelectionAction[] {
  const { overrides = {}, custom = [] } = parseSelectionActionsPref(
    application.getPreference(PrefKey.AssistantSelectionActions, ''),
  )

  const builtIns = DEFAULT_SELECTION_ACTIONS.map((action) => ({
    ...action,
    enabled: overrides[action.id as BuiltInSelectionActionId]?.enabled ?? action.enabled,
    prompt: overrides[action.id as BuiltInSelectionActionId]?.prompt ?? action.prompt,
  }))

  const customActions: SelectionAction[] = []
  const seen = new Set<string>(BUILT_IN_IDS)
  for (const record of custom) {
    const normalized = normalizeCustomAction(record)
    if (normalized && !seen.has(normalized.id)) {
      seen.add(normalized.id)
      customActions.push(normalized)
    }
  }

  return [...builtIns, ...customActions]
}

/**
 * Serialize the current set of effective actions back into the pref's
 * `{ overrides, custom }` shape. Built-ins contribute only their enabled/prompt
 * overrides; custom actions are stored verbatim. This is the single chokepoint the
 * Preferences UI uses to persist edits, adds, and removals.
 */
export function serializeSelectionActions(actions: SelectionAction[]): string {
  const overrides: Record<string, BuiltInOverride> = {}
  const custom: CustomActionRecord[] = []
  for (const action of actions) {
    if (action.custom || action.id.startsWith(CUSTOM_ACTION_ID_PREFIX)) {
      custom.push({
        id: action.id,
        label: action.label,
        prompt: action.prompt,
        enabled: action.enabled,
        icon: action.icon,
        needsLanguage: action.needsLanguage,
      })
    } else {
      overrides[action.id] = { enabled: action.enabled, prompt: action.prompt }
    }
  }
  return JSON.stringify({ overrides, custom })
}

/** Build a fresh, valid custom action with a unique prefixed id. */
export function createCustomSelectionAction(existing: SelectionAction[]): SelectionAction {
  const usedIds = new Set(existing.map((action) => action.id))
  let suffix = Date.now()
  let id = `${CUSTOM_ACTION_ID_PREFIX}${suffix}`
  while (usedIds.has(id)) {
    suffix += 1
    id = `${CUSTOM_ACTION_ID_PREFIX}${suffix}`
  }
  return {
    id,
    label: 'New action',
    icon: DEFAULT_CUSTOM_ACTION_ICON,
    enabled: true,
    prompt: '',
    custom: true,
  }
}

/** Whether the AI is usable right now, with a reason when it is not. */
export function getSelectionAIAvailability(application: WebApplication): { available: boolean; reason?: string } {
  const mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  if (mode === 'proxy') {
    if (!application.hasAccount()) {
      return { available: false, reason: 'Sign in to use the AI assistant.' }
    }
    if (!application.getPreference(PrefKey.AssistantProvider, '')) {
      return { available: false, reason: 'Choose an AI provider in Preferences → Assistant.' }
    }
    return { available: true }
  }
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const model = application.getPreference(PrefKey.AssistantModel, '')
  if (!baseURL || !model) {
    return { available: false, reason: 'Configure the AI endpoint and model in Preferences → Assistant.' }
  }
  return { available: true }
}

/**
 * Parses the AssistantExtraHeaders pref (JSON object or comma-separated
 * `Key: Value` list) into a header map. Never throws on malformed input.
 */
export function parseAssistantExtraHeaders(raw: string): Record<string, string> {
  if (!raw || !raw.trim()) {
    return {}
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v != null) {
          out[k] = `${v}`
        }
      }
      return out
    } catch {
      return {}
    }
  }
  const out: Record<string, string> = {}
  for (const pair of trimmed.split(',')) {
    const idx = pair.indexOf(':')
    if (idx === -1) {
      continue
    }
    const key = pair.slice(0, idx).trim()
    if (key) {
      out[key] = pair.slice(idx + 1).trim()
    }
  }
  return out
}

/**
 * Resolves the Direct-mode bearer token + extra headers. In 'api-key' mode the
 * bearer is the API key; in 'subscription' (OpenAI Codex / ChatGPT) mode it is
 * the subscription access token, and any extra headers (account id / OpenAI-Beta)
 * are merged in.
 */
export function resolveDirectAuth(application: WebApplication): {
  apiKey: string
  extraHeaders: Record<string, string>
} {
  const authMode = application.getPreference(PrefKey.AssistantAuthMode, 'api-key')
  const extraHeaders = parseAssistantExtraHeaders(application.getPreference(PrefKey.AssistantExtraHeaders, ''))
  if (authMode === 'subscription') {
    return {
      apiKey: application.getPreference(PrefKey.AssistantSubscriptionToken, ''),
      extraHeaders,
    }
  }
  return {
    apiKey: application.getPreference(PrefKey.AssistantApiKey, ''),
    extraHeaders,
  }
}

/**
 * Resolve the effective model / baseURL / sampling for a run, applying the active
 * persona profile's overrides (if any) on top of the global config. Empty profile
 * fields mean "inherit the global value". Exported so other run sites can reuse the
 * same precedence.
 */
export function resolveActiveProfileOverrides(application: WebApplication): {
  model: string
  baseURL: string
  sampling: SamplingSettings
} {
  const profile = getActiveProfile()
  const globalModel = application.getPreference(PrefKey.AssistantModel, '')
  const globalBaseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const sampling = loadSamplingSettings()
  if (!profile) {
    return { model: globalModel, baseURL: globalBaseURL, sampling }
  }
  return {
    model: profile.model || globalModel,
    baseURL: profile.baseURL || globalBaseURL,
    sampling: {
      ...sampling,
      temperature: profile.temperature,
      topP: profile.topP,
      maxTokens: profile.maxTokens,
    },
  }
}

function buildProvider(application: WebApplication, signal?: AbortSignal): Provider {
  const mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  const overrides = resolveActiveProfileOverrides(application)
  if (mode === 'proxy') {
    return new ProxyProvider({
      provider: application.getPreference(PrefKey.AssistantProvider, ''),
      model: overrides.model,
      sampling: overrides.sampling,
      signal,
      postStream: (body, sig) => application.assistantStreamRequest('/v1/assistant/stream', body, sig),
    })
  }
  const auth = resolveDirectAuth(application)
  return new DirectProvider({
    baseURL: overrides.baseURL,
    model: overrides.model,
    apiKey: auth.apiKey,
    extraHeaders: auth.extraHeaders,
    sampling: overrides.sampling,
    signal,
  })
}

/**
 * Issue a single (non-agentic) completion with an explicit system prompt and user
 * message, streaming partials through onDelta if provided. This is the shared
 * one-shot primitive that powers selection actions and narration; callers that just
 * transform selected text should use {@link runSelectionAction} instead.
 */
export async function runOneShotCompletion(
  application: WebApplication,
  system: string,
  user: string,
  options: { signal?: AbortSignal; onDelta?: (full: string) => void } = {},
): Promise<string> {
  const provider = buildProvider(application, options.signal)
  let text = ''
  for await (const event of provider.send({
    system,
    messages: [{ role: 'user', content: user }],
    tools: [],
  })) {
    if (event.kind === 'text-delta') {
      text += event.delta
      options.onDelta?.(text)
    } else if (event.kind === 'error') {
      throw new Error(event.message)
    } else if (event.kind === 'finish') {
      break
    }
  }
  return text.trim()
}

/**
 * Run a single (non-agentic) completion over the selected text and return the
 * result, streaming partials through onDelta if provided.
 */
export async function runSelectionAction(
  application: WebApplication,
  instruction: string,
  selectedText: string,
  options: { signal?: AbortSignal; onDelta?: (full: string) => void } = {},
): Promise<string> {
  const user = `${instruction.trim()}\n\n---\n${selectedText}`
  // Layer the user's persona (style only) onto the immutable selection-action base
  // prompt. The persona shapes tone but cannot relax the "reply with ONLY the
  // resulting text" contract or the safety rules (enforced in composeSystemPromptWithPersona).
  return runOneShotCompletion(application, composeSystemPromptWithPersona(SYSTEM_PROMPT), user, options)
}
