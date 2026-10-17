import type { AssistantToolPermissionMode } from '@/Assistant/assistantActionReview'
import CompactAssistantSelector from './CompactAssistantSelector'

export default function AssistantToolPermissionSelector({
  value,
  onChange,
  disabled,
}: {
  value: AssistantToolPermissionMode
  onChange: (value: AssistantToolPermissionMode) => void
  disabled?: boolean
}) {
  return (
    <CompactAssistantSelector
      label="Assistant tool permissions"
      icon="settings"
      value={value}
      onChange={(next) => onChange(next as AssistantToolPermissionMode)}
      disabled={disabled}
      options={[
        { value: 'ask', label: 'Ask each time', abbreviation: 'Ask', description: 'Ask before each tool action.' },
        {
          value: 'allow-read',
          label: 'Reads allowed',
          abbreviation: 'Read',
          description: 'Allow reads; ask before changes.',
        },
        {
          value: 'allow-safe',
          label: 'Safe changes',
          abbreviation: 'Safe',
          description: 'Allow safe changes; review higher-risk actions.',
        },
        {
          value: 'allow-all',
          label: 'All + review',
          abbreviation: 'Review',
          description: 'Review actions automatically before allowing them.',
        },
        {
          value: 'bypass',
          label: 'No prompts',
          abbreviation: 'Bypass',
          description: 'Skip confirmations where permitted. Mode and access restrictions still apply.',
        },
      ]}
    />
  )
}
