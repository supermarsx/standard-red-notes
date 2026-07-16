import { FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'
import { ListableContentItem } from './Types/ListableContentItem'

type Props = {
  item: {
    conflictOf?: ListableContentItem['conflictOf']
  }
}

const ListItemConflictIndicator: FunctionComponent<Props> = ({ item }) => {
  const { t } = useTranslation('notes')
  return item.conflictOf ? (
    <div className="mt-0.5 flex flex-wrap items-center">
      <div className={'bg-danger text-danger-contrast mt-2 mr-1 rounded px-1.5 py-1'}>
        <div className="text-center text-xs font-bold">{t('conflictedCopy')}</div>
      </div>
    </div>
  ) : null
}

export default ListItemConflictIndicator
