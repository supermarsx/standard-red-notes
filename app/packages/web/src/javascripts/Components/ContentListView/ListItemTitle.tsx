import { FunctionComponent } from 'react'
import { ListableContentItem } from './Types/ListableContentItem'
import Icon from '../Icon/Icon'
import { classNames } from '@standardnotes/snjs'

export const ListItemTitle: FunctionComponent<{ item: ListableContentItem }> = ({ item }) => {
  return (
    <div
      className={classNames(
        'break-word mr-2 overflow-hidden text-base leading-[1.25] font-semibold lg:text-sm lg:leading-[1.25]',
        item.archived ? 'opacity-60' : '',
      )}
    >
      {item.pinned && (
        <span className="bg-info text-info-contrast mr-1.5 inline-flex rounded-full p-0.5">
          <Icon type="pin-filled" size="custom" className="h-3 w-3" />
        </span>
      )}
      {item.title}
    </div>
  )
}
