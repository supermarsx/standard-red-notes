import { TrustedContactInterface } from '@standardnotes/models'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

const SharedByContactBadge = ({ contact }: { contact: TrustedContactInterface }) => {
  const { t } = useTranslation('sharing')
  return (
    <div title={t('sharedByContact')} className="flex items-center rounded bg-info px-1.5 py-1 text-neutral-contrast">
      <Icon ariaLabel={t('sharedByContact')} type="archive" className="mr-1 text-info-contrast" size="medium" />
      <div className="text-center text-sm font-semibold lg:text-xs">{contact.name}</div>
    </div>
  )
}

export default SharedByContactBadge
