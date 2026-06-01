import { describe, it, expect } from 'vitest'
import { run } from '../src/core/agent.js'
import { MockProvider } from '../src/providers/mock.js'
import type { McpSession } from '../src/mcp/session.js'

function fakeSession(toolResult: unknown): McpSession {
  return {
    tools: () => [
      {
        name: 'notes.search',
        description: 'search notes',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        scope: 'read',
      },
    ],
    call: async (_name: string, _args: unknown) => toolResult,
    start: async () => undefined,
    close: async () => undefined,
    refreshCatalog: async () => undefined,
  } as unknown as McpSession
}

describe('agent loop', () => {
  it('returns the model text when no tool calls are emitted', async () => {
    const provider = new MockProvider([
      [
        { kind: 'text-delta', delta: 'hi there' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])
    const session = fakeSession({ hits: [] })
    const result = await run([{ role: 'user', content: 'hi' }], { provider, session })
    expect(result.finalText).toBe('hi there')
    expect(result.steps).toBe(1)
    expect(result.stopReason).toBe('end_turn')
  })

  it('dispatches a tool call and feeds the result back', async () => {
    const provider = new MockProvider([
      [
        { kind: 'tool-call', id: 'c1', name: 'notes.search', args: { query: 'budget' } },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text-delta', delta: 'You have one budget note.' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])
    const session = fakeSession({ hits: [{ uuid: 'u1', title: 'Budget', snippet: 'q4' }] })
    const result = await run([{ role: 'user', content: 'budget notes?' }], { provider, session })
    expect(result.finalText).toBe('You have one budget note.')
    expect(result.steps).toBe(2)
  })

  it('respects max_steps and emits a forced summary', async () => {
    const looping = Array.from({ length: 3 }, (_, i) => [
      { kind: 'tool-call' as const, id: `c${i}`, name: 'notes.search', args: {} },
      { kind: 'finish' as const, stopReason: 'tool_use' as const },
    ])
    looping.push([
      { kind: 'text-delta', delta: 'forced summary' } as never,
      { kind: 'finish', stopReason: 'end_turn' } as never,
    ])
    const provider = new MockProvider(looping)
    const session = fakeSession({})
    const result = await run([{ role: 'user', content: 'spin forever' }], {
      provider,
      session,
      maxSteps: 3,
    })
    expect(result.stopReason).toBe('max_steps')
    expect(result.steps).toBe(3)
    expect(result.finalText).toBe('forced summary')
  })
})
