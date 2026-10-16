import { useId, useRef } from 'react'
import type { AssistantAttachment } from '@/Assistant/attachments'
import { AttachmentPreview } from './ComposerAttachments'
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
  attachments?: AssistantAttachment[]
  attachmentError?: string
  attachmentsBusy?: boolean
  imagesAllowed?: boolean
  onFiles?: (files: File[]) => void
  onRemoveAttachment?: (index: number) => void
  allowSteering?: boolean
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
  attachments = [],
  attachmentError,
  attachmentsBusy = false,
  imagesAllowed = false,
  onFiles,
  onRemoveAttachment,
  allowSteering = true,
}: Props) {
  const guidanceId = useId()
  const picker = useRef<HTMLInputElement>(null)
  const ready = Boolean(input.trim() || attachments.length) && !attachmentsBusy
  const steer = allowSteering && attachments.length === 0

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      onDragOver={(event) => {
        if (onFiles && event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        if (onFiles && event.dataTransfer.files.length) {
          event.preventDefault()
          onFiles(Array.from(event.dataTransfer.files))
        }
      }}
    >
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      {attachmentError && (
        <p role="alert" className="text-danger m-0 text-xs">
          {attachmentError}
        </p>
      )}
      {attachmentsBusy && (
        <p role="status" className="text-passive-0 m-0 text-xs">
          Preparing attachment…
        </p>
      )}
      {onFiles && (
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          aria-label="Choose assistant attachments"
          accept={
            imagesAllowed
              ? '.txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.sh,.sql,image/jpeg,image/png,image/webp'
              : '.txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.sh,.sql'
          }
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      )}

      <textarea
        aria-label="Message the assistant"
        aria-describedby={running ? guidanceId : undefined}
        className="border-border bg-default focus:border-info min-h-[2.5rem] w-full min-w-0 resize-none rounded border px-3 py-2 text-sm focus:outline-none"
        placeholder={running ? 'Add guidance, or write a follow-up…' : 'Message the assistant…'}
        value={input}
        rows={2}
        onChange={(event) => onInput(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length && onFiles) {
            event.preventDefault()
            onFiles(files)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (running) {
              if (steer) {
                onSteer()
              } else {
                onQueue()
              }
            } else {
              onSend()
            }
          }
        }}
      />
      <div className="flex min-h-[1.5rem] flex-wrap items-center justify-end gap-1">
        {onFiles && (
          <Button
            small
            className="px-2! py-1! text-[11px]!"
            label="Attach"
            title={
              imagesAllowed
                ? 'Attach UTF-8 text files or images (up to 3). Files are sent to the selected AI provider.'
                : 'Attach UTF-8 text files (up to 3). Image input is not enabled for this model.'
            }
            onClick={() => picker.current?.click()}
            disabled={attachmentsBusy || attachments.length >= 3}
          />
        )}
        {running ? (
          <>
            {steer && (
              <Button
                small
                className="px-2! py-1! text-[11px]!"
                primary
                label="Guide response"
                title="Add guidance to the current response without restarting it (Enter)"
                onClick={onSteer}
                disabled={!ready}
              />
            )}
            <Button
              small
              className="px-2! py-1! text-[11px]!"
              label="Queue next"
              title="Send this message after the current response finishes"
              onClick={onQueue}
              disabled={!ready}
            />
            <Button
              small
              className="px-2! py-1! text-[11px]!"
              label="Stop"
              title="Stop this response and clear queued messages"
              onClick={onStop}
            />
          </>
        ) : (
          <Button
            small
            className="px-2! py-1! text-[11px]!"
            primary
            label="Send"
            title="Send message (Enter); Shift+Enter adds a new line"
            onClick={onSend}
            disabled={!ready || !configured}
          />
        )}
      </div>
      {running && (
        <p id={guidanceId} className="text-passive-0 m-0 text-xs">
          {steer ? 'Guide response adds instructions now. ' : ''}Queue next sends a follow-up when this response
          finishes.
        </p>
      )}
    </div>
  )
}
