import { Select, SelectItem, SelectPopover, useSelectStore } from '@ariakit/react'
import type { ComponentProps } from 'react'
import Icon from '@/Components/Icon/Icon'

export type CompactAssistantOption = {
  value: string
  label: string
  abbreviation: string
  description: string
}

export default function CompactAssistantSelector({
  label,
  icon,
  value,
  onChange,
  disabled,
  options,
}: {
  label: string
  icon: ComponentProps<typeof Icon>['type']
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  options: CompactAssistantOption[]
}) {
  const store = useSelectStore({
    value,
    setValue: (next) => {
      if (!disabled) {
        onChange(next)
      }
    },
    placement: 'top-start',
  })
  const current = options.find((option) => option.value === value)
  return (
    <>
      <Select
        store={store}
        disabled={disabled}
        aria-label={label}
        title={`${label}: ${current?.label ?? value}. ${current?.description ?? ''}`}
        className="border-border bg-default text-text hover:bg-contrast flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
      >
        <Icon type={icon} size="small" />
        <span>{current?.abbreviation ?? value}</span>
        <Icon type="chevron-down" size="small" />
      </Select>
      <SelectPopover
        store={store}
        portal
        aria-label={label}
        className="z-dropdown-menu border-border bg-default text-text max-h-[var(--popover-available-height)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded border p-1 shadow-lg"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={disabled}
            title={option.description}
            className="hover:bg-contrast [&[data-active-item]]:bg-contrast flex cursor-pointer flex-col rounded px-2 py-1.5 text-left text-xs"
          >
            <span className="font-medium">{option.label}</span>
          </SelectItem>
        ))}
      </SelectPopover>
    </>
  )
}
