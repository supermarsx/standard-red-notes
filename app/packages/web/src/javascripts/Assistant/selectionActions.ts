import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { DirectProvider } from './DirectProvider'
import { ProxyProvider } from './ProxyProvider'
import { Provider } from './types'

export type SelectionActionId = 'ask' | 'refine' | 'summarize' | 'expand'

export type SelectionAction = {
  id: SelectionActionId
  label: string
  icon: string
  enabled: boolean
  /** Instruction applied to the selected text. */
  prompt: string
  /** True for actions that take a user-typed instruction (Ask AI). */
  freeform?: boolean
}

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
]

type Override = { enabled?: boolean; prompt?: string }

/**
 * Effective selection actions: built-in defaults (which a server may override via
 * the assistant config), overlaid with the user's per-action overrides.
 */
export function getSelectionActions(application: WebApplication): SelectionAction[] {
  let overrides: Partial<Record<SelectionActionId, Override>> = {}
  const raw = application.getPreference(PrefKey.AssistantSelectionActions, '')
  if (raw) {
    try {
      overrides = JSON.parse(raw) as Partial<Record<SelectionActionId, Override>>
    } catch {
      /* malformed override; fall back to defaults */
    }
  }
  return DEFAULT_SELECTION_ACTIONS.map((action) => ({
    ...action,
    enabled: overrides[action.id]?.enabled ?? action.enabled,
    prompt: overrides[action.id]?.prompt ?? action.prompt,
  }))
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

function buildProvider(application: WebApplication, signal?: AbortSignal): Provider {
  const mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  if (mode === 'proxy') {
    return new ProxyProvider({
      provider: application.getPreference(PrefKey.AssistantProvider, ''),
      model: application.getPreference(PrefKey.AssistantModel, ''),
      signal,
      postStream: (body, sig) => application.assistantStreamRequest('/v1/assistant/stream', body, sig),
    })
  }
  const auth = resolveDirectAuth(application)
  return new DirectProvider({
    baseURL: application.getPreference(PrefKey.AssistantBaseUrl, ''),
    model: application.getPreference(PrefKey.AssistantModel, ''),
    apiKey: auth.apiKey,
    extraHeaders: auth.extraHeaders,
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
  return runOneShotCompletion(application, SYSTEM_PROMPT, user, options)
}
