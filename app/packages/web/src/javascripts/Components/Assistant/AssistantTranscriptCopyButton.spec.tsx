/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { addToast, ToastType } from '@standardnotes/toast'
import AssistantTranscriptCopyButton, { assistantTranscriptForCopy } from './AssistantTranscriptCopyButton'

jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Success: 'success', Error: 'error' } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Copy Assistant transcript', () => {
  let root: Root
  let container: HTMLDivElement
  const writeText = jest.fn()
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    writeText.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (navigator as { clipboard?: Clipboard }).clipboard
  })
  it('copies visible role-labelled text in order without tool details or errors', async () => {
    const messages = [
      { id: '1', kind: 'user' as const, text: 'Summarize this' },
      { id: '2', kind: 'assistant' as const, text: '**Summary**', tools: [{ args: 'private arguments' }] },
      { id: '3', kind: 'error' as const, text: 'internal error' },
      { id: '4', kind: 'assistant' as const, text: '' },
    ]
    await act(async () => root.render(<AssistantTranscriptCopyButton messages={messages} />))
    await act(async () => container.querySelector('button')!.click())
    expect(writeText).toHaveBeenCalledWith('You:\nSummarize this\n\nAssistant:\n**Summary**')
    expect(addToast).toHaveBeenCalledWith({ type: ToastType.Success, message: 'Chat transcript copied' })
  })
  it('does not include unexpected system or tool messages at runtime', () => {
    const messages = [{ id: 'system', kind: 'system', text: 'private instructions' }]
    expect(assistantTranscriptForCopy(messages as never)).toBe('')
  })
  it('copies the current snapshot while replying and reports clipboard failures', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {})
    writeText.mockRejectedValue(new Error('Clipboard refused'))
    try {
      await act(async () =>
        root.render(
          <AssistantTranscriptCopyButton
            messages={[{ id: '1', kind: 'assistant', text: 'Partial', streaming: true }]}
          />,
        ),
      )
      await act(async () => container.querySelector('button')!.click())
      expect(writeText).toHaveBeenCalledWith('Assistant:\nPartial')
      expect(addToast).toHaveBeenCalledWith({ type: ToastType.Error, message: "Couldn't copy to clipboard" })
    } finally {
      errorLog.mockRestore()
    }
  })
  it('disables copying an empty chat', async () => {
    await act(async () => root.render(<AssistantTranscriptCopyButton messages={[]} />))
    expect(container.querySelector('button')!.disabled).toBe(true)
  })
})
