import { classNames } from '@standardnotes/utils'
import { FunctionComponent } from 'react'
import Icon from '@/Components/Icon/Icon'
import { TagColorOptions } from './TagColors'

type Props = {
  selectedColor?: string
  onChange: (color: string | undefined) => void
  className?: string
}

const TagColorPicker: FunctionComponent<Props> = ({ selectedColor, onChange, className }) => {
  return (
    <div className={classNames('flex flex-col', className)}>
      <div className="mb-1.5 font-semibold">Color</div>
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          aria-label="No color"
          title="None"
          onClick={() => onChange(undefined)}
          className={classNames(
            'flex h-5 w-5 items-center justify-center rounded-full border border-border',
            !selectedColor && 'ring-2 ring-info ring-offset-1 ring-offset-default',
          )}
        >
          <Icon type="close" size="small" className="text-neutral" />
        </button>
        {TagColorOptions.map((option) => {
          const isSelected = selectedColor?.toLowerCase() === option.value.toLowerCase()
          return (
            <button
              key={option.value}
              aria-label={option.label}
              title={option.label}
              onClick={() => onChange(option.value)}
              className={classNames(
                'h-5 w-5 rounded-full border border-[rgba(0,0,0,0.1)]',
                isSelected && 'ring-2 ring-info ring-offset-1 ring-offset-default',
              )}
              style={{ backgroundColor: option.value }}
            />
          )
        })}
      </div>
    </div>
  )
}

export default TagColorPicker
