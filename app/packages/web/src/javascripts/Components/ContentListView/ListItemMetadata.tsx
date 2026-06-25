import { CollectionSort, CollectionSortProperty } from '@standardnotes/snjs'
import { FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'
import { ListableContentItem } from './Types/ListableContentItem'

type Props = {
  item: {
    protected: ListableContentItem['protected']
    updatedAtString?: ListableContentItem['updatedAtString']
    createdAtString?: ListableContentItem['createdAtString']
  }
  hideDate: boolean
  sortBy: CollectionSortProperty | undefined
}

const ListItemMetadata: FunctionComponent<Props> = ({ item, hideDate, sortBy }) => {
  const { t } = useTranslation('notes')
  const showModifiedDate = sortBy === CollectionSort.UpdatedAt

  if (hideDate && !item.protected) {
    return null
  }

  return (
    <div className="leading-1.4 mt-0.5 text-sm opacity-50 lg:text-xs">
      {item.protected && (
        <span>
          {t('protected')} {hideDate ? '' : ' • '}
        </span>
      )}
      {!hideDate && showModifiedDate && (
        <span>
          {t('modified')} {item.updatedAtString || t('now')}
        </span>
      )}
      {!hideDate && !showModifiedDate && <span>{item.createdAtString || t('now')}</span>}
    </div>
  )
}

export default ListItemMetadata
