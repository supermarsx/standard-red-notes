import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { copyTextToClipboard } from '@/Utils/copyTextToClipboard'
import { assistantMessageTextForCopy, type AssistantMessageActionTarget } from './AssistantMessageActions'

/** Only visible conversational text is exported, never tool arguments, results, or attached file data. */
export function assistantTranscriptForCopy(messages: readonly AssistantMessageActionTarget[]): string {
  return messages
    .filter((message) => message.kind === 'user' || message.kind === 'assistant')
    .map((message) => {
      const text = assistantMessageTextForCopy(message)
      return text.trim() ? `${message.kind === 'user' ? 'You' : 'Assistant'}:\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

export default function AssistantTranscriptCopyButton({
  messages,
}: {
  messages: readonly AssistantMessageActionTarget[]
}) {
  const hasText = messages.some(
    (message) => (message.kind === 'user' || message.kind === 'assistant') && message.text.trim().length > 0,
  )
  return (
    <StyledTooltip label="Copy chat transcript">
      <button
        type="button"
        aria-label="Copy chat transcript"
        disabled={!hasText}
        className="text-passive-1 hover:bg-contrast hover:text-text focus-visible:ring-info inline-flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 disabled:opacity-50"
        onClick={() => copyTextToClipboard(assistantTranscriptForCopy(messages), 'Chat transcript copied')}
      >
        <Icon type="copy" size="small" />
      </button>
    </StyledTooltip>
  )
}
