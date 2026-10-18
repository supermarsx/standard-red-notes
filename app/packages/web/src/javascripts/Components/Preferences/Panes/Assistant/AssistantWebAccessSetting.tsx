import { useId } from 'react'
import type { AssistantWebAccessMode } from '@/Assistant/assistantWebAccessPolicy'

const descriptions: Record<AssistantWebAccessMode, string> = {
  allow: 'Searches and page reads proceed without individual approvals.',
  safe: 'Approve each search query. The assistant can then read its returned pages automatically; other URLs need approval.',
  strict: 'Approve every search query and every page read.',
}
export default function AssistantWebAccessSetting({
  value,
  disabled,
  onChange,
}: {
  value: AssistantWebAccessMode
  disabled: boolean
  onChange: (value: AssistantWebAccessMode) => void
}) {
  const id = useId()
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          Web approvals
        </label>
        <select
          id={id}
          aria-describedby={`${id}-description`}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as AssistantWebAccessMode)}
          className="border-border bg-default text-default rounded border px-2 py-1 text-sm disabled:opacity-60"
        >
          <option value="allow">Allow (default)</option>
          <option value="safe">Safe</option>
          <option value="strict">Strict</option>
        </select>
      </div>
      <p id={`${id}-description`} className="text-passive-1 mt-1 text-xs">
        {descriptions[value]}
      </p>
    </div>
  )
}
