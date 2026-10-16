import type { AssistantConversationMode } from '@/Assistant/conversationModes'

export default function AssistantModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: AssistantConversationMode
  onChange: (mode: AssistantConversationMode) => void
  disabled?: boolean
}) {
  return (
    <label className="flex max-w-full min-w-0 items-center gap-1 text-xs">
      <span className="text-passive-1 shrink-0 text-[11px] font-medium">Mode</span>
      <select
        aria-label="Assistant mode"
        className="border-border bg-default text-text max-w-full min-w-0 rounded border px-1.5 py-0.5 text-[11px]"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AssistantConversationMode)}
      >
        <option value="chat">Chat</option>
        <option value="agent">Agent</option>
        <option value="plan">Plan</option>
        <option value="research">Research</option>
        <option value="deep-research">Deep Research</option>
      </select>
    </label>
  )
}
