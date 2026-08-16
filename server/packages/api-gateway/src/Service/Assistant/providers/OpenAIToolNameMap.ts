const OPENAI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_TOOL_NAME_LENGTH = 64

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function aliasBase(name: string): string {
  const suffix = `_${stableHash(name)}`
  const stem = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'tool'
  return `srn_${stem.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 4)}${suffix}`
}

export function createOpenAIToolNameMap(names: readonly string[]): {
  toWireName: (internalName: string) => string
  toInternalName: (wireName: string) => string
} {
  const internalToWire = new Map<string, string>()
  const wireToInternal = new Map<string, string>()
  const uniqueNames = [...new Set(names)].sort()

  for (const name of uniqueNames) {
    if (OPENAI_TOOL_NAME_PATTERN.test(name)) {
      internalToWire.set(name, name)
      wireToInternal.set(name, name)
    }
  }

  for (const name of uniqueNames) {
    if (internalToWire.has(name)) {
      continue
    }
    const base = aliasBase(name)
    let candidate = base
    let collision = 2
    while (wireToInternal.has(candidate)) {
      const counter = `_${collision++}`
      candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - counter.length)}${counter}`
    }
    internalToWire.set(name, candidate)
    wireToInternal.set(candidate, name)
  }

  return {
    toWireName: (name) => internalToWire.get(name) ?? name,
    toInternalName: (name) => wireToInternal.get(name) ?? name,
  }
}

export function openAIToolNamesForRequest(
  tools: ReadonlyArray<{ name: string }>,
  messages: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string }> }>,
): ReturnType<typeof createOpenAIToolNameMap> {
  return createOpenAIToolNameMap([
    ...tools.map((tool) => tool.name),
    ...messages.flatMap((message) => message.toolCalls?.map((toolCall) => toolCall.name) ?? []),
  ])
}

function cleanErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, 512) : undefined
}

export function openAIStreamErrorMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return undefined
  }
  const record = event as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const details = error as Record<string, unknown>
    return cleanErrorMessage(details.message) ?? cleanErrorMessage(details.detail) ?? 'Provider returned an error.'
  }
  if (error !== undefined && error !== null) {
    return cleanErrorMessage(error) ?? 'Provider returned an error.'
  }
  return record.type === 'error' ? (cleanErrorMessage(record.message) ?? 'Provider returned an error.') : undefined
}
