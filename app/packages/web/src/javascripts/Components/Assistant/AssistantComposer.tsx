import { useId } from 'react'
import Button from '@/Components/Button/Button'

interface Props {
  input: string
  running: boolean
  configured: boolean
  onInput: (value: string) => void
  onSend: () => void
  onSteer: () => void
  onQueue: () => void
  onStop: () => void
}

/** Keep the typing area stable when a running response exposes its controls. */
export default function AssistantComposer({
  input,
  running,
  configured,
  onInput,
  onSend,
  onSteer,
  onQueue,
  onStop,
}: Props) {
  const guidanceId = useId()
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <textarea
        aria-label="Message the assistant"
        aria-describedby={running ? guidanceId : undefined}
        className="border-border bg-default focus:border-info min-h-[2.5rem] w-full min-w-0 resize-none rounded border px-3 py-2 text-sm focus:outline-none"
        placeholder={running ? 'Add guidance, or write a follow-up…' : 'Message the assistant…'}
        value={input}
        rows={2}
        onChange={(event) => onInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (running) {
              onSteer()
            } else {
              onSend()
            }
          }
        }}
      />
      <div className="flex min-h-[2rem] flex-wrap items-center justify-end gap-2">
        {running ? (
          <>
            <Button
              small
              primary
              label="Guide response"
              title="Add guidance to the current response without restarting it (Enter)"
              onClick={onSteer}
              disabled={!input.trim()}
            />
            <Button
              small
              label="Queue next"
              title="Send this message after the current response finishes"
              onClick={onQueue}
              disabled={!input.trim()}
            />
            <Button small label="Stop" title="Stop this response and clear queued messages" onClick={onStop} />
          </>
        ) : (
          <Button
            small
            primary
            label="Send"
            title="Send message (Enter); Shift+Enter adds a new line"
            onClick={onSend}
            disabled={!input.trim() || !configured}
          />
        )}
      </div>
      {running && (
        <p id={guidanceId} className="text-passive-0 m-0 text-xs">
          Guide response adds instructions now. Queue next sends a follow-up when this response finishes.
        </p>
      )}
    </div>
  )
}
