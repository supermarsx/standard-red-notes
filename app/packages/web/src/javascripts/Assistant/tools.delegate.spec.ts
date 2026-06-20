import { WebApplication } from '@/Application/WebApplication'
import { AssistantTools, AssistantToolContext } from './tools'

function makeContext(runSubAgent?: AssistantToolContext['runSubAgent']): AssistantToolContext {
  return {
    confirmBeforeWrite: false,
    requestConfirmation: async () => true,
    presentPane: () => {},
    runSubAgent,
  }
}

const fakeApp = {} as unknown as WebApplication

describe('AssistantTools delegate', () => {
  it('exposes the delegate tool at the top level when a sub-agent runner is provided', () => {
    const tools = new AssistantTools(fakeApp, makeContext(async () => 'ok'))
    expect(tools.tools().some((t) => t.name === 'delegate')).toBe(true)
  })

  it('withholds delegate when no sub-agent runner is provided', () => {
    const tools = new AssistantTools(fakeApp, makeContext(undefined))
    expect(tools.tools().some((t) => t.name === 'delegate')).toBe(false)
  })

  it('withholds delegate from sub-agents (recursion guard) and rejects the call', async () => {
    const sub = new AssistantTools(fakeApp, makeContext(async () => 'ok'), false)
    expect(sub.tools().some((t) => t.name === 'delegate')).toBe(false)
    await expect(sub.call('delegate', { task: 'x' })).rejects.toThrow('Unknown tool')
  })

  it('routes a delegate call to the sub-agent runner and returns its summary', async () => {
    const seen: Array<{ task: string; context?: string }> = []
    const runSubAgent = async (task: string, contextText?: string) => {
      seen.push({ task, context: contextText })
      return `handled: ${task}`
    }
    const tools = new AssistantTools(fakeApp, makeContext(runSubAgent))
    const result = await tools.call('delegate', { task: 'organize notes', context: 'uuid-1' })
    expect(result).toEqual({ ok: true, result: 'handled: organize notes' })
    expect(seen).toEqual([{ task: 'organize notes', context: 'uuid-1' }])
  })

  it('rejects a delegate call with no task', async () => {
    const tools = new AssistantTools(fakeApp, makeContext(async () => 'ok'))
    await expect(tools.call('delegate', {})).rejects.toThrow('task')
  })
})
