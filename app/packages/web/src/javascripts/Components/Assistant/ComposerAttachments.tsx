import type { AssistantAttachment } from '@/Assistant/attachments'

export function AttachmentPreview({
  attachments,
  onRemove,
}: {
  attachments: readonly AssistantAttachment[]
  onRemove?: (index: number) => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <div
          key={index}
          className="border-border bg-default flex max-w-full items-center gap-2 rounded border px-2 py-1 text-xs"
        >
          {attachment.kind === 'image' && (
            <img src={attachment.dataUrl} alt={attachment.name} className="h-10 w-10 rounded object-contain" />
          )}
          <span className="min-w-0 break-all">
            {attachment.name}
            {attachment.kind === 'text' ? ' · text file' : ' · image'}
          </span>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${attachment.name}`}
              className="text-passive-0 hover:text-danger shrink-0 px-1"
              onClick={() => onRemove(index)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
