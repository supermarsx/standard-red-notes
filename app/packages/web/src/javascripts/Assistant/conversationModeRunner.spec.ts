import type { WebApplication } from '@/Application/WebApplication'
import { runConversationMode, ConversationModeExtras } from './conversationModeRunner'
import { AgentOptions } from './agent'
import type { Provider, ProviderEvent, ProviderRequest, ToolDefinition } from './types'
import { webFetch, webSearch } from './webTools'
import { isAssistantConversationMode, normalizeAssistantConversationMode } from './conversationModes'
import { AssistantTools } from './tools'

jest.mock('./webTools', () => ({ webSearch: jest.fn(), webFetch: jest.fn() }))

const definitions: ToolDefinition[] = [
  { name: 'notes.read', mutating: false, description: 'Read', inputSchema: {} },
  { name: 'notes.create', mutating: true, description: 'Create', inputSchema: {} },
  { name: 'web.search', mutating: false, description: 'Search', inputSchema: {} },
  { name: 'web.fetch', mutating: false, description: 'Fetch', inputSchema: {} },
]
function setup(script?: (request: ProviderRequest, index: number) => ProviderEvent[]) {
  const seen: ProviderRequest[] = []
  const provider: Provider = {
    id: 'test',
    async *send(request) {
      const index = seen.length
      seen.push(request)
      yield* script?.(request, index) ?? [
        { kind: 'text-delta', delta: '# Report\nEvidence summary' },
        { kind: 'finish', stopReason: 'end_turn' },
      ]
    },
  }
  const session = {
    tools: jest.fn(() => definitions),
    call: jest.fn(async () => ({ ok: true })),
    setAbortSignal: jest.fn(),
  }
  const options: AgentOptions = {
    provider,
    session,
    systemPrompt: 'trusted app prompt',
    maxSteps: 3,
    maxRunTimeMs: 10_000,
    onTextDelta: jest.fn(),
  }
  const application = {
    get items() {
      throw new Error('Must never scan the note library')
    },
  } as unknown as WebApplication
  const extras: ConversationModeExtras = {
    application,
    prompt: 'research public topic',
    contextText: 'PRIVATE scoped excerpt',
    isCurrent: () => true,
    requestWebConfirmation: jest.fn(async () => true),
  }
  return { seen, session, options, extras }
}
beforeEach(() => {
  jest
    .mocked(webSearch)
    .mockResolvedValue({ results: [{ title: 'Source', url: 'https://example.test/source', snippet: 'Evidence' }] })
  jest.mocked(webFetch).mockResolvedValue({ title: 'Source', text: 'Retrieved public evidence' })
})

it('strictly recognizes supported modes while legacy UI falls back to Agent', () => {
  expect(isAssistantConversationMode('plan')).toBe(true)
  expect(isAssistantConversationMode('unknown')).toBe(false)
  expect(normalizeAssistantConversationMode(undefined)).toBe('agent')
})

it.each(['chat', 'plan', 'agent', 'research', 'deep-research'] as const)(
  '%s respects the account internet lockdown',
  async (mode) => {
    const harness = setup()
    harness.options.session = new AssistantTools({ getPreference: () => false } as unknown as WebApplication, {
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })
    await runConversationMode(mode, [], harness.options, harness.extras)
    expect(webSearch).not.toHaveBeenCalled()
    expect(webFetch).not.toHaveBeenCalled()
    expect(harness.extras.requestWebConfirmation).not.toHaveBeenCalled()
  },
)

it.each(['chat', 'plan'] as const)(
  '%s rejects a forged write tool independently of model instructions and forwards abort signal',
  async (mode) => {
    const harness = setup((_request, index) =>
      index === 0
        ? [
            { kind: 'tool-call', id: 'call', name: 'notes.create', args: {} },
            { kind: 'finish', stopReason: 'tool_use' },
          ]
        : [
            { kind: 'text-delta', delta: 'Safe response' },
            { kind: 'finish', stopReason: 'end_turn' },
          ],
    )
    const result = await runConversationMode(
      mode,
      [{ role: 'user', content: 'change note' }],
      harness.options,
      harness.extras,
    )
    expect(result.stopReason).toBe('error')
    expect(result.errorCode).toBe('ACTION_NOT_ALLOWED')
    expect(harness.seen).toHaveLength(1)
    expect(harness.session.call).not.toHaveBeenCalled()
    expect(harness.seen[0].tools.some((tool) => tool.name === 'notes.create')).toBe(false)
    expect(harness.session.setAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  },
)

it.each(['chat', 'plan', 'agent'] as const)('%s retains approved read tools', async (mode) => {
  const harness = setup((_request, index) =>
    index === 0
      ? [
          { kind: 'tool-call', id: 'read', name: 'notes.read', args: { uuid: 'source' } },
          { kind: 'finish', stopReason: 'tool_use' },
        ]
      : [{ kind: 'finish', stopReason: 'end_turn' }],
  )
  await runConversationMode(mode, [{ role: 'user', content: 'read' }], harness.options, harness.extras)
  expect(harness.session.call).toHaveBeenCalledWith('notes.read', { uuid: 'source' }, 'read')
})

it('preserves selected context in the Chat model request while exposing only read tools', async () => {
  const harness = setup()
  harness.options.systemPrompt = 'Trusted instructions\nSelected context: PRIVATE scoped excerpt'
  await runConversationMode('chat', [{ role: 'user', content: 'Summarize this' }], harness.options, harness.extras)
  expect(harness.seen[0].system).toContain('Selected context: PRIVATE scoped excerpt')
  expect(harness.seen[0].tools.map((tool) => tool.name)).toEqual(['notes.read', 'web.search', 'web.fetch'])
  expect(harness.seen[0].system).toContain('do not make changes')
})

it.each(['chat', 'plan'] as const)('%s checks the current tool scope again before executing a read', async (mode) => {
  let current = true
  const harness = setup(() => {
    current = false
    return [
      { kind: 'tool-call', id: 'read', name: 'notes.read', args: { uuid: 'source' } },
      { kind: 'finish', stopReason: 'tool_use' },
    ]
  })
  harness.extras.isCurrent = () => current
  await runConversationMode(mode, [], harness.options, harness.extras)
  expect(harness.session.call).not.toHaveBeenCalled()
})

it.each(['research', 'deep-research'] as const)(
  '%s uses only explicit scoped context and never includes it in the approved web query',
  async (mode) => {
    const harness = setup()
    const result = await runConversationMode(mode, [], harness.options, harness.extras)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Evidence summary')
    expect(harness.seen.length).toBeGreaterThan(0)
    expect(harness.seen.every((request) => request.tools.length === 0)).toBe(true)
    expect(harness.seen.map((request) => JSON.stringify(request.messages)).join(' ')).toContain(
      'PRIVATE scoped excerpt',
    )
    expect(webSearch).toHaveBeenCalledWith(
      harness.extras.application,
      'research public topic',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(harness.extras.requestWebConfirmation).toHaveBeenCalledWith('search', 'research public topic')
    expect(harness.extras.requestWebConfirmation).toHaveBeenCalledWith('fetch', 'https://example.test/source')
    expect(harness.session.call).not.toHaveBeenCalled()
    expect(harness.options.onTextDelta).toHaveBeenCalledWith(result.finalText)
  },
)

it.each(['research', 'deep-research'] as const)(
  '%s stops on a denied query or page approval before calling the model',
  async (mode) => {
    for (const declined of ['search', 'fetch']) {
      jest.mocked(webSearch).mockClear()
      jest.mocked(webFetch).mockClear()
      const harness = setup()
      harness.extras.requestWebConfirmation = jest.fn(async (action) => action !== declined)
      const result = await runConversationMode(mode, [], harness.options, harness.extras)
      expect(result).toMatchObject({ stopReason: 'error', errorCode: 'ACTION_NOT_ALLOWED' })
      expect(result.finalText).toContain('was not allowed')
      expect(harness.seen).toHaveLength(0)
      expect(webFetch).not.toHaveBeenCalled()
      if (declined === 'search') {
        expect(webSearch).not.toHaveBeenCalled()
      }
    }
  },
)

it('performs no web requests after a denied approval or when the approval path is absent', async () => {
  const harness = setup()
  harness.extras.requestWebConfirmation = jest.fn(async () => false)
  await runConversationMode('research', [], harness.options, harness.extras)
  expect(webSearch).not.toHaveBeenCalled()
  await runConversationMode('research', [], harness.options, { ...harness.extras, requestWebConfirmation: undefined })
  expect(webSearch).not.toHaveBeenCalled()
})

it('stops if internet permission disappears while approval is open', async () => {
  const harness = setup()
  harness.extras.requestWebConfirmation = jest.fn(async () => {
    harness.session.tools.mockReturnValue([])
    return true
  })
  const result = await runConversationMode('research', [], harness.options, harness.extras)
  expect(result).toMatchObject({ stopReason: 'error', errorCode: 'ACTION_NOT_ALLOWED' })
  expect(harness.seen).toHaveLength(0)
  expect(webSearch).not.toHaveBeenCalled()
  expect(webFetch).not.toHaveBeenCalled()
})

it('rechecks context authorization after web approval and before any disclosure or model call', async () => {
  const harness = setup()
  let current = true
  harness.extras.isCurrent = () => current
  harness.extras.requestWebConfirmation = async () => {
    current = false
    return true
  }
  const result = await runConversationMode('research', [], harness.options, harness.extras)
  expect(result.stopReason).toBe('aborted')
  expect(webSearch).not.toHaveBeenCalled()
  expect(harness.seen).toHaveLength(0)
})

it('keeps web requests off when the tools are unavailable', async () => {
  const harness = setup()
  harness.session.tools.mockReturnValue(definitions.filter((tool) => !tool.name.startsWith('web.')))
  await runConversationMode('research', [], harness.options, harness.extras)
  expect(webSearch).not.toHaveBeenCalled()
  expect(harness.extras.requestWebConfirmation).not.toHaveBeenCalled()
})

it('bounds a hung approval and never starts work when its delayed approval later resolves', async () => {
  jest.useFakeTimers()
  const harness = setup()
  let resolveApproval!: (value: boolean) => void
  harness.extras.requestWebConfirmation = () =>
    new Promise((resolve) => {
      resolveApproval = resolve
    })
  try {
    const execution = runConversationMode('research', [], { ...harness.options, maxRunTimeMs: 1_000 }, harness.extras)
    await jest.advanceTimersByTimeAsync(1_001)
    expect((await execution).stopReason).toBe('time_limit')
    resolveApproval(true)
    await Promise.resolve()
    expect(webSearch).not.toHaveBeenCalled()
    expect(harness.seen).toHaveLength(0)
  } finally {
    jest.useRealTimers()
  }
})

it('bounds a hung provider read and requests stream cleanup without awaiting it', async () => {
  jest.useFakeTimers()
  const harness = setup()
  const close = jest.fn(async () => ({ done: true as const, value: undefined }))
  const next = jest.fn(() => new Promise<IteratorResult<ProviderEvent>>(() => {}))
  harness.options.provider = { id: 'hung', send: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) }
  try {
    const execution = runConversationMode(
      'research',
      [],
      { ...harness.options, maxRunTimeMs: 1_000 },
      { ...harness.extras, requestWebConfirmation: undefined },
    )
    await jest.advanceTimersByTimeAsync(1_001)
    expect((await execution).stopReason).toBe('time_limit')
    expect(next).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it('enforces the complete-run model call budget, including deep refinement and synthesis', async () => {
  const harness = setup()
  harness.extras.contextText = 'part '.repeat(4_000)
  const result = await runConversationMode(
    'deep-research',
    [],
    { ...harness.options, maxSteps: 1 },
    { ...harness.extras, requestWebConfirmation: undefined },
  )
  expect(harness.seen).toHaveLength(1)
  expect(result.steps).toBe(1)
  expect(result.stopReason).toBe('end_turn')
})

it('refuses model tool calls during research without retrying or executing them', async () => {
  const harness = setup(() => [
    { kind: 'tool-call', id: 'forged', name: 'notes.create', args: {} },
    { kind: 'finish', stopReason: 'tool_use' },
  ])
  const result = await runConversationMode('research', [], harness.options, {
    ...harness.extras,
    requestWebConfirmation: undefined,
  })
  expect(result.stopReason).toBe('error')
  expect(harness.seen).toHaveLength(1)
  expect(harness.session.call).not.toHaveBeenCalled()
})

it('keeps a timed-out partial report visibly incomplete rather than presenting it as a finished report', async () => {
  jest.useFakeTimers()
  const harness = setup()
  let reads = 0
  harness.options.provider = {
    id: 'partial',
    send: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          reads++ === 0
            ? { done: false as const, value: { kind: 'text-delta' as const, delta: '# Partial findings' } }
            : new Promise<IteratorResult<ProviderEvent>>(() => {}),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    }),
  }
  try {
    const execution = runConversationMode(
      'research',
      [],
      { ...harness.options, maxRunTimeMs: 1_000 },
      { ...harness.extras, requestWebConfirmation: undefined },
    )
    await jest.advanceTimersByTimeAsync(1_001)
    const result = await execution
    expect(result.stopReason).toBe('time_limit')
    expect(result.finalText).toContain('# Partial findings')
    expect(result.finalText).toContain('run-time limit')
    expect(result.finalText).toContain('This report is incomplete.')
    expect(harness.options.onTextDelta).toHaveBeenCalledTimes(1)
    expect(harness.options.onTextDelta).toHaveBeenCalledWith(result.finalText)
  } finally {
    jest.useRealTimers()
  }
})

it('sends native image context only to the model, never to research queries', async () => {
  const harness = setup()
  const image = {
    kind: 'image' as const,
    name: 'private.jpg',
    dataUrl: 'data:image/jpeg;base64,/9j/wAAICAABAAEB/9k=',
    width: 1,
    height: 1,
  }
  await runConversationMode('research', [], harness.options, { ...harness.extras, images: [image] })
  expect(harness.seen[0].messages[0].images).toEqual([image])
  expect(JSON.stringify(jest.mocked(webSearch).mock.calls.map((call) => call[1]))).not.toContain('private.jpg')
  expect(JSON.stringify(jest.mocked(webSearch).mock.calls.map((call) => call[1]))).not.toContain(
    'PRIVATE scoped excerpt',
  )
})
it('drains a token-limited research response through EOF and returns its actual incomplete disposition without retry', async () => {
  const harness = setup(() => [
    { kind: 'text-delta', delta: 'Partial findings' },
    { kind: 'finish', stopReason: 'max_tokens' },
    { kind: 'usage', totalTokens: 42 },
  ])
  const result = await runConversationMode('deep-research', [], harness.options, {
    ...harness.extras,
    requestWebConfirmation: undefined,
  })
  expect(result.stopReason).toBe('max_tokens')
  expect(result.finalText).toContain('Partial findings')
  expect(result.finalText).toContain('incomplete')
  expect(harness.seen).toHaveLength(1)
})
