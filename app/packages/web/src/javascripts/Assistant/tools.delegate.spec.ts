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

describe('AssistantTools todo.write', () => {
  it('replaces the list, drops empty items, and reports via onTodosChanged', async () => {
    let reported: unknown
    const ctx = { ...makeContext(), onTodosChanged: (todos: unknown) => (reported = todos) }
    const tools = new AssistantTools(fakeApp, ctx)
    const result = await tools.call('todo.write', {
      todos: [
        { content: 'Search notes', status: 'in_progress' },
        { content: '', status: 'pending' },
        { content: 'Summarize', status: 'pending' },
      ],
    })
    const expected = [
      { content: 'Search notes', status: 'in_progress' },
      { content: 'Summarize', status: 'pending' },
    ]
    expect(result).toEqual({ ok: true, todos: expected })
    expect(reported).toEqual(expected)
  })

  it('defaults an invalid status to pending', async () => {
    const tools = new AssistantTools(fakeApp, makeContext())
    const result = (await tools.call('todo.write', { todos: [{ content: 'X', status: 'bogus' }] })) as {
      todos: Array<{ status: string }>
    }
    expect(result.todos[0].status).toBe('pending')
  })
})

describe('AssistantTools notes.retrieve', () => {
  const appWithNotes = {
    items: {
      getItems: () => [
        { uuid: 'n1', title: 'Sourdough', text: 'feed the starter with flour and water', trashed: false },
        { uuid: 'n2', title: 'Taxes', text: 'quarterly deductions and receipts', trashed: false },
        { uuid: 'n3', title: 'Trashed', text: 'flour flour flour', trashed: true },
      ],
    },
  } as unknown as WebApplication

  it('returns relevance-ranked passages and excludes trashed notes', async () => {
    const tools = new AssistantTools(appWithNotes, makeContext())
    const result = (await tools.call('notes.retrieve', { query: 'sourdough starter flour' })) as {
      count: number
      results: Array<{ noteUuid: string }>
    }
    expect(result.count).toBeGreaterThan(0)
    expect(result.results[0].noteUuid).toBe('n1')
    expect(result.results.some((r) => r.noteUuid === 'n3')).toBe(false)
  })

  it('requires a query', async () => {
    const tools = new AssistantTools(appWithNotes, makeContext())
    await expect(tools.call('notes.retrieve', {})).rejects.toThrow('query')
  })
})
