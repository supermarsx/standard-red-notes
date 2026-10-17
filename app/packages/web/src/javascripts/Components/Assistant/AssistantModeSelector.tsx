import type { AssistantConversationMode } from '@/Assistant/conversationModes'
import CompactAssistantSelector, { type CompactAssistantOption } from './CompactAssistantSelector'

const modes: CompactAssistantOption[] = [
  {
    value: 'chat',
    abbreviation: 'Chat',
    label: 'Chat',
    description: 'Discuss the selected context using read-only tools when needed, without changing notes.',
  },
  {
    value: 'agent',
    abbreviation: 'Agent',
    label: 'Agent',
    description: 'Use tools to work with notes and complete tasks, subject to your tool permissions.',
  },
  {
    value: 'plan',
    abbreviation: 'Plan',
    label: 'Plan',
    description: 'Inspect context with read-only tools and propose a plan without making changes.',
  },
  {
    value: 'research',
    abbreviation: 'Res.',
    label: 'Research',
    description:
      'Create a structured report from the topic and context. Web evidence is used when configured and approved.',
  },
  {
    value: 'deep-research',
    abbreviation: 'Deep',
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
    <CompactAssistantSelector
      label="Assistant mode"
      icon="assistant"
      value={value}
      onChange={(next) => onChange(next as AssistantConversationMode)}
      disabled={disabled}
      options={modes}
    />
  )
}
