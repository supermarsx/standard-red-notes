import { classNames, IconType } from '@standardnotes/snjs'
import IconButton from '@/Components/Button/IconButton'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { ElementFormatType } from 'lexical'
import { useTranslation } from 'react-i18next'

export function getCSSValueFromAlignment(format: ElementFormatType) {
  switch (format) {
    case 'start':
    case 'left':
      return 'start'
    case 'right':
    case 'end':
      return 'end'
    default:
      return 'center'
  }
}

const Options = [
  {
    alignment: 'left',
    labelKey: 'leftAlign',
  },
  {
    alignment: 'center',
    labelKey: 'centerAlign',
  },
  {
    alignment: 'right',
    labelKey: 'rightAlign',
  },
] as const

export function ImageAlignmentOptions({
  alignment: currentAlignment,
  changeAlignment,
}: {
  alignment: ElementFormatType
  changeAlignment: (format: ElementFormatType) => void
}) {
  const { t } = useTranslation('files')
  return Options.map(({ alignment, labelKey }) => {
    const label = t(labelKey)
    return (
    <StyledTooltip label={label} key={alignment}>
      <IconButton
        className={classNames(
          alignment === currentAlignment && '!bg-info text-info-contrast',
          'rounded p-1 hover:bg-contrast',
        )}
        icon={`format-align-${alignment}` as IconType}
        title={label}
        focusable={true}
        onClick={(e) => {
          // the preventDefault and stopPropagation for these events are required
          // so that the keyboard doesn't jump when you select another option
          e.preventDefault()
          e.stopPropagation()
          changeAlignment(alignment as ElementFormatType)
        }}
        onMouseDown={(e) => {
          e.preventDefault()
        }}
      />
    </StyledTooltip>
    )
  })
}
