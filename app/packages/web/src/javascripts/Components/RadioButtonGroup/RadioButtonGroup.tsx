import { VisuallyHidden, Radio, RadioGroup, useRadioStore } from '@ariakit/react'
import { classNames } from '@standardnotes/utils'

type Props<Value extends string> = {
  items: { label: string; value: Value }[]
  value: Value
  onChange: (value: Value) => void
  className?: string
}

function RadioButtonGroup<Value extends string>({ value, items, onChange, className }: Props<Value>) {
  const radio = useRadioStore({
    value,
    orientation: 'horizontal',
    setValue(value) {
      onChange(value as Value)
    },
  })

  return (
    <RadioGroup
      store={radio}
      className={`divide-border border-border md:translucent-ui:border-[--popover-border-color] flex divide-x rounded border ${
        className ?? ''
      }`}
    >
      {items.map(({ label, value: itemValue }) => (
        <label
          className={classNames(
            'flex-grow px-3.5 py-1.5 text-center select-none',
            'first:rounded-tl first:rounded-bl last:rounded-tr last:rounded-br',
            itemValue === value &&
              'bg-info-backdrop text-info ring-info font-medium ring-1 ring-inset focus-within:ring-2',
          )}
          key={itemValue}
        >
          <VisuallyHidden>
            <Radio value={itemValue} />
          </VisuallyHidden>
          {label}
        </label>
      ))}
    </RadioGroup>
  )
}

export default RadioButtonGroup
