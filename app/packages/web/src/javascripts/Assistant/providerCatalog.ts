// Static, framework-free catalog of AI providers the server proxy can be
// configured to expose. This mirrors the server-side preset/provider table so
// the Assistant preferences UI can render human-readable labels and show which
// providers exist at all (not just those currently configured on the server).
//
// The server remains the source of truth for which providers are actually
// usable — keys are server-held and never sent to the client. This catalog is
// purely presentational: it is cross-referenced against the `providers` array
// returned by GET /v1/assistant/config to mark which entries are configured.
//
// keep in sync with server providers/presets.ts (§2 of the t23 plan).

export interface ProviderCatalogEntry {
  id: string
  label: string
  kind: 'preset' | 'native'
  keyRequired: boolean
  notes?: string
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // Native providers — implemented directly against each vendor's wire format.
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'native', keyRequired: true },
  { id: 'gemini', label: 'Google Gemini', kind: 'native', keyRequired: true },
  { id: 'cohere', label: 'Cohere', kind: 'native', keyRequired: true },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'native',
    keyRequired: false,
    notes: 'Local server; no API key required.',
  },

  // OpenAI-compatible presets — one shared code path over an id → base URL map.
  { id: 'openai', label: 'OpenAI', kind: 'preset', keyRequired: true },
  { id: 'groq', label: 'Groq', kind: 'preset', keyRequired: true },
  { id: 'together', label: 'Together', kind: 'preset', keyRequired: true },
  { id: 'openrouter', label: 'OpenRouter', kind: 'preset', keyRequired: true },
  { id: 'deepseek', label: 'DeepSeek', kind: 'preset', keyRequired: true },
  { id: 'mistral', label: 'Mistral', kind: 'preset', keyRequired: true },
  {
    id: 'perplexity',
    label: 'Perplexity',
    kind: 'preset',
    keyRequired: true,
    notes: 'Model discovery may be unavailable; enter a model identifier manually.',
  },
  { id: 'xai', label: 'xAI (Grok)', kind: 'preset', keyRequired: true },
  { id: 'fireworks', label: 'Fireworks', kind: 'preset', keyRequired: true },
  { id: 'google-openai', label: 'Google Gemini (OpenAI-compat)', kind: 'preset', keyRequired: true },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    kind: 'preset',
    keyRequired: true,
    notes: 'Requires a deployment-scoped base URL and api-version configured on the server.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'preset',
    keyRequired: false,
    notes: 'Local server; no API key required.',
  },
  {
    id: 'ollama-openai',
    label: 'Ollama (OpenAI-compat)',
    kind: 'preset',
    keyRequired: false,
    notes: 'Local server; no API key required.',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'preset',
    keyRequired: false,
    notes: 'Bring your own base URL configured on the server.',
  },
]

const CATALOG_BY_ID: Map<string, ProviderCatalogEntry> = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]))

/**
 * Returns the human-readable label for a provider id, falling back to the raw
 * id when the provider is not part of the static catalog (e.g. a server-only id).
 */
export function catalogLabel(id: string): string {
  return CATALOG_BY_ID.get(id)?.label ?? id
}

export type ConfiguredProviderCatalogEntry = ProviderCatalogEntry & { configured: boolean }

/**
 * Cross-references the static catalog against the provider ids the server
 * reports as configured. Every catalog entry is returned with a `configured`
 * flag, and any configured id that is not part of the static catalog is
 * appended as an ad-hoc entry (label = id) so server-only providers still show.
 */
export function mergeWithConfigured(configuredIds: string[]): ConfiguredProviderCatalogEntry[] {
  const configured = new Set(configuredIds)

  const merged: ConfiguredProviderCatalogEntry[] = PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    configured: configured.has(entry.id),
  }))

  for (const id of configuredIds) {
    if (!CATALOG_BY_ID.has(id)) {
      merged.push({ id, label: id, kind: 'preset', keyRequired: true, configured: true })
    }
  }

  return merged
}
