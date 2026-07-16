import { TrustedContactInterface } from '@standardnotes/models'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

const SharedByContactBadge = ({ contact }: { contact: TrustedContactInterface }) => {
  const { t } = useTranslation('sharing')
  return (
    <div title={t('sharedByContact')} className="bg-info text-neutral-contrast flex items-center rounded px-1.5 py-1">
      <Icon ariaLabel={t('sharedByContact')} type="archive" className="text-info-contrast mr-1" size="medium" />
      <div className="text-center text-sm font-semibold lg:text-xs">{contact.name}</div>
    </div>
  )
}

export default SharedByContactBadge
