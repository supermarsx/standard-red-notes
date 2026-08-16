export type ModelDiscoveryEntry = Record<string, unknown> & {
  supported_parameters?: unknown
}

function isRecord(value: unknown): value is ModelDiscoveryEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * OpenRouter advertises tool support through `supported_parameters`. Generic
 * OpenAI-compatible servers usually omit that field, so absence (or malformed
 * metadata) must remain backward compatible. Only an explicit, valid string
 * array that omits `tools` is authoritative evidence that the model is unsafe
 * to advertise to the tool-using assistant.
 */
export function toolCapableModelEntries(value: unknown): ModelDiscoveryEntry[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).filter((entry) => {
    const parameters = entry.supported_parameters
    return (
      !Array.isArray(parameters) ||
      !parameters.every((parameter): parameter is string => typeof parameter === 'string') ||
      parameters.includes('tools')
    )
  })
}
