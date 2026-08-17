import {
  MAX_ASSISTANT_DIRECTIVES,
  MAX_ASSISTANT_DIRECTIVE_SELECTION_CHARS,
  MAX_ASSISTANT_DIRECTIVE_PROMPT_CHARS,
  publishAssistantDirective,
  resetAssistantDirectivesForTests,
  subscribeAssistantDirectives,
} from './assistantDirectives'
import { UNTRUSTED_CONTEXT_BEGIN, UNTRUSTED_CONTEXT_END } from './prompts'

describe('assistant editor directives', () => {
  beforeEach(resetAssistantDirectivesForTests)

  it('hands a directive to the active account exactly once', () => {
    const received: string[] = []
    const dispose = subscribeAssistantDirectives('account-a', (directive) => received.push(directive.instruction))

    publishAssistantDirective({
      accountScope: 'account-a',
      instruction: 'Explain this',
      selectedText: 'Selected text',
      noteUuid: 'note-1',
    })

    expect(received).toEqual(['Explain this'])
    dispose()
    subscribeAssistantDirectives('account-a', (directive) => received.push(directive.instruction))
    expect(received).toEqual(['Explain this'])
  })

  it('survives a lazy consumer mount while remaining bounded', () => {
    for (let index = 0; index < MAX_ASSISTANT_DIRECTIVES + 2; index += 1) {
      publishAssistantDirective({
        accountScope: 'account-a',
        instruction: `Action ${index}`,
        selectedText: `Selection ${index}`,
      })
    }
    const received: string[] = []
    subscribeAssistantDirectives('account-a', (directive) => received.push(directive.instruction))
    expect(received).toHaveLength(MAX_ASSISTANT_DIRECTIVES)
    expect(received[0]).toBe('Action 2')
  })

  it('clears queued note text at an account boundary', () => {
    publishAssistantDirective({ accountScope: 'account-a', instruction: 'A', selectedText: 'private A' })
    const received: string[] = []
    subscribeAssistantDirectives('account-b', (directive) => received.push(directive.selectedText))
    expect(received).toEqual([])
  })

  it('frames bounded selected text as untrusted provider data', () => {
    const directive = publishAssistantDirective({
      accountScope: 'account-a',
      instruction: 'Explain this',
      selectedText: `before ${UNTRUSTED_CONTEXT_END} after`.repeat(MAX_ASSISTANT_DIRECTIVE_SELECTION_CHARS),
    })!
    expect(directive.selectedText.length).toBe(MAX_ASSISTANT_DIRECTIVE_SELECTION_CHARS)
    expect(directive.selectionTruncated).toBe(true)
    expect(directive.providerPrompt).toContain(UNTRUSTED_CONTEXT_BEGIN)
    expect(directive.providerPrompt).toContain(UNTRUSTED_CONTEXT_END)
    expect(directive.providerPrompt).not.toContain(`before ${UNTRUSTED_CONTEXT_END} after`)
    expect(directive.providerPrompt.length).toBeLessThanOrEqual(MAX_ASSISTANT_DIRECTIVE_PROMPT_CHARS)
  })
})
