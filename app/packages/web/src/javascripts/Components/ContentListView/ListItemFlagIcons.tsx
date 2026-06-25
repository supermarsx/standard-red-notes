import { FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '@/Components/Icon/Icon'
import { ListableContentItem } from './Types/ListableContentItem'
import { classNames } from '@standardnotes/snjs'

type Props = {
  item: {
    locked: ListableContentItem['locked']
    trashed: ListableContentItem['trashed']
    archived: ListableContentItem['archived']
    pinned: ListableContentItem['pinned']
    starred: ListableContentItem['starred']
  }
  hasFiles?: boolean
  hasBorder?: boolean
  isFileBackedUp?: boolean
  className?: string
}

const ListItemFlagIcons: FunctionComponent<Props> = ({
  item,
  hasFiles = false,
  hasBorder = true,
  isFileBackedUp = false,
  className,
}) => {
  const { t } = useTranslation('notes')
  return (
    <div className={classNames('flex items-start pl-0', hasBorder && 'border-b border-solid border-border', className)}>
      {item.locked && (
        <span className="flex items-center" title={t('editingDisabled')}>
          <Icon ariaLabel={t('editingDisabled')} type="pencil-off" className="text-info" size="medium" />
        </span>
      )}
      {item.trashed && (
        <span className="ml-1.5 flex items-center" title={t('trashed')}>
          <Icon ariaLabel={t('trashed')} type="trash-filled" className="text-danger" size="medium" />
        </span>
      )}
      {item.archived && (
        <span className="ml-1.5 flex items-center" title={t('archived')}>
          <Icon ariaLabel={t('archived')} type="archive" className="text-accessory-tint-3" size="medium" />
        </span>
      )}
      {hasFiles && (
        <span className="ml-1.5 flex items-center" title={t('files')}>
          <Icon ariaLabel={t('files')} type="attachment-file" className="text-info" size="medium" />
        </span>
      )}
      {item.starred && (
        <span className="ml-1.5 flex items-center" title={t('starred')}>
          <Icon ariaLabel={t('starred')} type="star-filled" className="text-warning" size="medium" />
        </span>
      )}
      {isFileBackedUp && (
        <span className="ml-1.5 flex items-center" title={t('fileBackedUpLocally')}>
          <Icon ariaLabel={t('fileBackedUpLocally')} type="check-circle" className="text-info" size="medium" />
        </span>
      )}
    </div>
  )
}

export default ListItemFlagIcons
