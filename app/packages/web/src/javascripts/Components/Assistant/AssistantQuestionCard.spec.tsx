/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AssistantQuestionCard from './AssistantQuestionCard'
import { useAssistantUserQuestion } from './useAssistantUserQuestion'
import { normalizeAssistantUserQuestion } from '@/Assistant/assistantUserQuestion'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const question = {
  question: 'Which scope?',
  options: ['This section', 'This note', 'All selected notes'] as [string, string, string],
}
describe('Assistant clarification', () => {
  let container: HTMLDivElement
  let root: Root
  let api: ReturnType<typeof useAssistantUserQuestion>
  let identity = 'account/chat'
  function Harness() {
    api = useAssistantUserQuestion(identity)
    return api.pending ? (
      <AssistantQuestionCard key={api.pending.token} question={api.pending.question} onAnswer={api.answer} />
    ) : null
  }
  beforeEach(async () => {
    identity = 'account/chat'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
  })
  it('shows exactly three suggestions and returns a chosen answer', async () => {
    let response!: ReturnType<typeof api.request>
    await act(async () => {
      response = api.request(question)
    })
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      ...question.options,
      'Cancel',
      'Send answer',
    ])
    await act(async () => container.querySelector('button')!.click())
    await expect(response).resolves.toEqual({ answer: 'This section', optionIndex: 0 })
    expect(container.textContent).toBe('')
  })
  it('accepts a custom answer and never chooses an option on Cancel', async () => {
    let response!: ReturnType<typeof api.request>
    await act(async () => {
      response = api.request(question)
    })
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '  My own scope  ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Send answer')!.click(),
    )
    await expect(response).resolves.toEqual({ answer: 'My own scope' })
    await act(async () => {
      response = api.request(question)
    })
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click(),
    )
    await expect(response).resolves.toBeNull()
  })
  it('cancels on abort and rejects stale responses after replacement', async () => {
    const controller = new AbortController()
    let first!: ReturnType<typeof api.request>
    let second!: ReturnType<typeof api.request>
    await act(async () => {
      first = api.request(question)
    })
    const staleAnswer = api.answer
    await act(async () => {
      second = api.request(question, controller.signal)
    })
    await expect(first).resolves.toBeNull()
    await act(async () => staleAnswer({ answer: 'This section', optionIndex: 0 }))
    expect(container.querySelector('fieldset')).not.toBeNull()
    await act(async () => controller.abort())
    await expect(second).resolves.toBeNull()
    expect(container.querySelector('fieldset')).toBeNull()
  })
  it('cancels across account changes and unmount', async () => {
    let response!: ReturnType<typeof api.request>
    await act(async () => {
      response = api.request(question)
    })
    identity = 'different/chat'
    await act(async () => root.render(<Harness />))
    await expect(response).resolves.toBeNull()
    await act(async () => {
      response = api.request(question)
    })
    await act(async () => root.unmount())
    await expect(response).resolves.toBeNull()
  })
  it('rejects malformed or duplicate suggestions rather than presenting a partial choice', () => {
    expect(normalizeAssistantUserQuestion({ ...question, options: ['One', 'Two'] })).toBeUndefined()
    expect(normalizeAssistantUserQuestion({ ...question, options: ['One', 'one', 'Two'] })).toBeUndefined()
    expect(normalizeAssistantUserQuestion({ ...question, question: '<script>plain text</script>' })?.question).toBe(
      '<script>plain text</script>',
    )
  })
})
