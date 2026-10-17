import type { AssistantConversationMode } from '@/Assistant/conversationModes'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'

const modes: { value: AssistantConversationMode; label: string; description: string }[] = [
  { value: 'chat', label: 'Chat', description: 'Discuss the supplied context without using tools or changing notes.' },
  {
    value: 'agent',
    label: 'Agent',
    description: 'Use tools to work with notes and complete tasks, subject to your tool permissions.',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Inspect context with read-only tools and propose a plan without making changes.',
  },
  {
    value: 'research',
    label: 'Research',
    description:
      'Create a structured report from the topic and context. Web evidence is used when configured and approved.',
  },
  {
    value: 'deep-research',
    label: 'Deep Research',
    description:
      'Develop a more detailed report over multiple research and refinement steps. Web evidence is used when configured and approved.',
  },
]

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
      <StyledTooltip
        type="description"
        showOnMobile
        className="max-w-sm"
        label={
          <dl className="space-y-2 text-xs">
            {modes.map((mode) => (
              <div key={mode.value}>
                <dt className="font-semibold">{mode.label}</dt>
                <dd>{mode.description}</dd>
              </div>
            ))}
          </dl>
        }
      >
        <select
          aria-label="Assistant mode"
          className="border-border bg-default text-text max-w-full min-w-0 rounded border px-1.5 py-0.5 text-[11px]"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as AssistantConversationMode)}
        >
          {modes.map((mode) => (
            <option key={mode.value} value={mode.value} title={mode.description}>
              {mode.label}
            </option>
          ))}
        </select>
      </StyledTooltip>
    </label>
  )
}
