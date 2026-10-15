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
      className={`bg-info text-info-contrast inline-flex h-5 w-24 max-w-full shrink-0 items-center gap-1 overflow-hidden rounded px-1 whitespace-nowrap select-none ${contact ? '' : 'invisible'}`}
    >
      <Icon ariaLabel={t('lastEditedBy')} type="pencil" className="text-info-contrast h-3 w-3 shrink-0" size="custom" />
      <span className="min-w-0 truncate text-[11px] leading-none">{contact?.name}</span>
    </div>
  )
}

export default LastEditedByBadge
