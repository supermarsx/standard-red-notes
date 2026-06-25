import { TrustedContactInterface } from '@standardnotes/models'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

const LastEditedByBadge = ({ contact }: { contact: TrustedContactInterface }) => {
  const { t } = useTranslation('sharing')
  return (
    <div
      title={t('lastEditedBy')}
      className="flex select-none items-center rounded bg-info px-1.5 py-1 text-info-contrast"
    >
      <Icon ariaLabel={t('sharedBy')} type="pencil" className="mr-1 text-info-contrast" size="medium" />
      <span className="mr-auto overflow-hidden text-ellipsis text-sm font-semibold lg:text-xs">{contact.name}</span>
    </div>
  )
}

export default LastEditedByBadge
