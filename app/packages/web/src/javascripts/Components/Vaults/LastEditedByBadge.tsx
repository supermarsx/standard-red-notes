import { TrustedContactInterface } from '@standardnotes/models'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

const LastEditedByBadge = ({ contact }: { contact?: TrustedContactInterface }) => {
  const { t } = useTranslation('sharing')
  return (
    <div
      title={contact ? `${t('lastEditedBy')}: ${contact.name}` : undefined}
      aria-hidden={contact ? undefined : true}
      data-last-edited-badge
      className={`bg-info text-info-contrast flex h-7 w-36 max-w-full shrink-0 items-center rounded px-1.5 py-1 select-none ${contact ? '' : 'invisible'}`}
    >
      <Icon ariaLabel={t('lastEditedBy')} type="pencil" className="text-info-contrast mr-1 shrink-0" size="medium" />
      <span className="min-w-0 truncate text-sm font-semibold lg:text-xs">{contact?.name}</span>
    </div>
  )
}

export default LastEditedByBadge
