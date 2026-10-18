import { AssistantTools, AssistantToolContext } from './tools'
import { WebApplication } from '@/Application/WebApplication'

jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({ HeadlessSuperConverter: class {} }))
const question = { question: 'Which target?', options: ['Current note', 'Selected section', 'New note'] }
const make = (extra: Partial<AssistantToolContext> = {}) =>
  new AssistantTools({} as WebApplication, {
    confirmBeforeWrite: true,
    requestConfirmation: jest.fn(async () => true),
    presentPane: jest.fn(),
    ...extra,
  })
it('withholds questions when no answer UI exists', () => {
  expect(
    make()
      .tools()
      .some((tool) => tool.name === 'assistant.askUser'),
  ).toBe(false)
})
it('collects a custom answer without a redundant permission popup', async () => {
  const requestConfirmation = jest.fn(async () => true)
  const requestUserAnswer = jest.fn(async () => ({ answer: 'Only the introduction' }))
  const tools = make({ requestUserAnswer, requestConfirmation, shouldRequestConfirmation: () => true })
  await expect(tools.call('assistant.askUser', question)).resolves.toEqual({ answer: 'Only the introduction' })
  expect(requestConfirmation).not.toHaveBeenCalled()
  expect(requestUserAnswer).toHaveBeenCalledWith(question, undefined)
})
it('accepts an exact selected option and sanitizes callback output', async () => {
  const tools = make({ requestUserAnswer: async () => ({ answer: 'Current note', optionIndex: 0, secret: 'omit' }) })
  await expect(tools.call('assistant.askUser', question)).resolves.toEqual({ answer: 'Current note', optionIndex: 0 })
})
it.each(
  [[], ['one', 'two'], ['one', 'one', 'two'], ['one', ' ONE ', 'two'], ['one', '', 'two']].map((options) => ({
    options,
  })),
)('rejects invalid options %p before opening UI', async ({ options }) => {
  const requestUserAnswer = jest.fn(async () => null)
  await expect(make({ requestUserAnswer }).call('assistant.askUser', { ...question, options })).rejects.toThrow(
    'exactly three',
  )
  expect(requestUserAnswer).not.toHaveBeenCalled()
})
it('does not treat dismissal as an answer', async () => {
  await expect(
    make({ requestUserAnswer: async () => null }).call('assistant.askUser', question),
  ).resolves.toMatchObject({ cancelled: true })
})
it('rejects mismatched or oversized answers', async () => {
  await expect(
    make({ requestUserAnswer: async () => ({ answer: 'New note', optionIndex: 0 }) }).call(
      'assistant.askUser',
      question,
    ),
  ).rejects.toThrow('invalid')
  await expect(
    make({ requestUserAnswer: async () => ({ answer: 'x'.repeat(2001) }) }).call('assistant.askUser', question),
  ).rejects.toThrow('invalid')
})
it('fences the result after account/session changes', async () => {
  let current = true
  const tools = make({
    isSessionCurrent: () => current,
    requestUserAnswer: async () => {
      current = false
      return { answer: 'New note' }
    },
  })
  await expect(tools.call('assistant.askUser', question)).rejects.toThrow()
})
it('fences the result after cancellation', async () => {
  const controller = new AbortController()
  const tools = make({
    signal: controller.signal,
    requestUserAnswer: async () => {
      controller.abort()
      return { answer: 'New note' }
    },
  })
  await expect(tools.call('assistant.askUser', question)).rejects.toThrow()
})
