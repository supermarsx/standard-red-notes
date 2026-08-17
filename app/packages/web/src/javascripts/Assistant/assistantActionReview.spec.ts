import {
  canPreflightAutoAllow,
  classifyAssistantToolRisk,
  legacyConfirmBeforeWriteForMode,
  reviewAssistantAction,
  shouldConfirmAssistantTool,
} from './assistantActionReview'
import { Provider } from './types'

const provider = (output: string): Provider => ({
  id: 'test',
  async *send() {
    yield { kind: 'text-delta', delta: output } as const
    yield { kind: 'finish', stopReason: 'end_turn' } as const
  },
})

describe('assistant action review', () => {
  it('keeps the legacy boolean in ask mode for every richer permission policy', () => {
    expect(
      ['ask', 'allow-read', 'allow-safe', 'allow-all'].map((mode) => legacyConfirmBeforeWriteForMode(mode as never)),
    ).toEqual([true, true, true, true])
  })
  it('keeps destructive and external actions outside automatic approval', async () => {
    const deleted = { name: 'notes.delete', args: { uuid: 'note' } }
    const emailed = { name: 'reminders.set', args: { datetime: '2026-01-01', email: true } }
    const webSearch = { name: 'web.search', args: { query: 'private project codename' } }
    expect(classifyAssistantToolRisk(deleted)).toBe('irreversible')
    expect(classifyAssistantToolRisk(emailed)).toBe('external')
    expect(classifyAssistantToolRisk(webSearch)).toBe('external')
    expect(canPreflightAutoAllow(deleted)).toBe(false)
    await expect(reviewAssistantAction(provider('ALLOW'), deleted)).resolves.toEqual({
      decision: 'ask',
      reason: 'This action requires explicit approval.',
    })
  })

  it('requires an exact allow response and fails closed otherwise', async () => {
    const request = { name: 'tags.create', args: { title: 'Work' } }
    await expect(reviewAssistantAction(provider('ALLOW'), request)).resolves.toMatchObject({ decision: 'allow' })
    await expect(reviewAssistantAction(provider('allow this'), request)).resolves.toMatchObject({ decision: 'ask' })
  })

  it('never auto-allows truncated or omitted action material', async () => {
    let calls = 0
    const approvingProvider: Provider = {
      id: 'should-not-run',
      async *send() {
        calls += 1
        yield { kind: 'text-delta', delta: 'ALLOW' }
        yield { kind: 'finish', stopReason: 'end_turn' }
      },
    }
    const longBody = { name: 'notes.update', args: { uuid: 'note', text: `benign ${'x'.repeat(600)} harmful` } }
    const manyFields = {
      name: 'notes.create',
      args: { title: 'A', text: 'B', one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 },
    }

    expect(canPreflightAutoAllow(longBody)).toBe(false)
    expect(canPreflightAutoAllow(manyFields)).toBe(false)
    await expect(reviewAssistantAction(approvingProvider, longBody)).resolves.toMatchObject({ decision: 'ask' })
    await expect(reviewAssistantAction(approvingProvider, manyFields)).resolves.toMatchObject({ decision: 'ask' })
    expect(calls).toBe(0)
  })

  it('requires a terminal success and sends bounded intent with the cancellation signal', async () => {
    const controller = new AbortController()
    let sentRequest: Parameters<Provider['send']>[0] | undefined
    const incomplete: Provider = {
      id: 'incomplete',
      async *send(request) {
        sentRequest = request
        yield { kind: 'text-delta', delta: 'ALLOW' }
      },
    }
    const request = { name: 'tags.create', args: { title: 'Work' } }

    await expect(
      reviewAssistantAction(incomplete, request, {
        signal: controller.signal,
        userIntent: `Create a work tag ${'x'.repeat(2_000)}`,
      }),
    ).resolves.toMatchObject({ decision: 'ask' })
    expect(sentRequest?.signal).toBe(controller.signal)
    expect(sentRequest?.maxOutputTokens).toBe(8)
    expect(sentRequest?.purpose).toBe('safety-review')
    expect(sentRequest?.messages[0].content.length).toBeLessThan(1_300)
    expect(sentRequest?.messages[0].content).toContain('Create a work tag')
  })

  it('always asks before external web traffic, even in read-allowing modes', () => {
    const request = { name: 'web.search', args: { query: 'sensitive terms' } }
    expect(shouldConfirmAssistantTool('allow-read', request, false)).toBe(true)
    expect(shouldConfirmAssistantTool('allow-safe', request, false)).toBe(true)
    expect(shouldConfirmAssistantTool('allow-all', request, false)).toBe(true)
  })

  it('keeps ask mode authoritative over cached or safe classifications', () => {
    expect(shouldConfirmAssistantTool('ask', { name: 'notes.read', args: { uuid: 'note' } }, false)).toBe(true)
    expect(shouldConfirmAssistantTool('allow-read', { name: 'notes.read', args: { uuid: 'note' } }, false)).toBe(false)
  })
})
