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
      'Create a structured report from the topic and context. Internet access follows your web permissions. You choose whether to save the findings to a note.',
  },
  {
    value: 'deep-research',
    abbreviation: 'Deep',
    label: 'Deep Research',
    description:
      'Search, read and compare up to 600 sources over multiple rounds, with a configurable time budget that can exceed an hour. Keep this tab open; stop at any time. You choose whether to save the findings to a note.',
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
