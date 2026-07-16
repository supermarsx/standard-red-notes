import { FunctionComponent } from 'react'
import Icon from '@/Components/Icon/Icon'
import { DisplayableListItemProps } from './Types/DisplayableListItemProps'
import { ListableContentItem } from './Types/ListableContentItem'

type Props = {
  hideTags: boolean
  tags: DisplayableListItemProps<ListableContentItem>['tags']
}

const ListItemTags: FunctionComponent<Props> = ({ hideTags, tags }) => {
  if (hideTags || !tags.length) {
    return null
  }

  return (
    <div className="mt-1 flex flex-wrap gap-2 overflow-hidden text-sm lg:text-xs">
      {tags.map((tag) => (
        <span
          className="bg-passive-4-opacity-variant text-foreground inline-flex items-center rounded px-1.5 py-1"
          key={tag.uuid}
        >
          <Icon type={tag.iconString} className="text-passive-1 mr-1" size="small" />
          <span>{tag.title}</span>
        </span>
      ))}
    </div>
  )
}

export default ListItemTags
