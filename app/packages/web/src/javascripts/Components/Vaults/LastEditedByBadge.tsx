import { TrustedContactInterface } from '@standardnotes/models'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

const LastEditedByBadge = ({ contact }: { contact: TrustedContactInterface }) => {
  const { t } = useTranslation('sharing')
  return (
    <div
      title={t('lastEditedBy')}
      className="bg-info text-info-contrast flex items-center rounded px-1.5 py-1 select-none"
    >
      <Icon ariaLabel={t('sharedBy')} type="pencil" className="text-info-contrast mr-1" size="medium" />
      <span className="mr-auto overflow-hidden text-sm font-semibold text-ellipsis lg:text-xs">{contact.name}</span>
    </div>
  )
}

export default LastEditedByBadge
