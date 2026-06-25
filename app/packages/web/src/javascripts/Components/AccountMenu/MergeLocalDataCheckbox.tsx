import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { ChangeEventHandler, FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  checked: boolean
  onChange: ChangeEventHandler<HTMLInputElement>
  disabled?: boolean
  notesAndTagsCount: number
}

const MergeLocalDataCheckbox: FunctionComponent<Props> = ({ checked, onChange, disabled, notesAndTagsCount }) => {
  const { t } = useTranslation('auth')

  return (
    <label htmlFor="should-merge-local" className="fit-content mb-2 flex items-center text-sm">
      <input
        className="mr-2 accent-danger"
        type="checkbox"
        name="should-merge-local"
        id="should-merge-local"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className="text-danger">{t('mergeLocalData', { count: notesAndTagsCount })}</span>
      <StyledTooltip
        label={t('mergeLocalDataTooltip')}
        showOnMobile
        className="!z-modal !max-w-[30ch] whitespace-normal"
      >
        <button type="button" className="ml-1 rounded-full p-0.5 hover:bg-contrast">
          <Icon type="info" className="text-danger" size="small" />
        </button>
      </StyledTooltip>
    </label>
  )
}

export default MergeLocalDataCheckbox
