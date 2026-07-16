import { splitQueryInString } from '@/Utils'
import { classNames } from '@standardnotes/utils'
import { getTitleForLinkedTag } from '@/Utils/Items/Display/getTitleForLinkedTag'
import { getIconForItem } from '@/Utils/Items/Icons/getIconForItem'
import { LinkableItem } from '@/Utils/Items/Search/LinkableItem'
import { observer } from 'mobx-react-lite'
import { useApplication } from '../ApplicationProvider'
import Icon from '../Icon/Icon'
import { getItemTitleInContextOfLinkBubble } from '@/Utils/Items/Search/doesItemMatchSearchQuery'

type Props = {
  item: LinkableItem
  searchQuery?: string
}

const LinkedItemMeta = ({ item, searchQuery }: Props) => {
  const application = useApplication()
  const [icon, className] = getIconForItem(item, application)
  const tagTitle = getTitleForLinkedTag(item, application)
  const title = getItemTitleInContextOfLinkBubble(item)

  return (
    <>
      <Icon type={icon} className={classNames('flex-shrink-0', className)} />
      <div className="min-w-0 flex-grow text-left text-base break-words lg:text-sm">
        {tagTitle && <span className="text-passive-1">{tagTitle.titlePrefix}</span>}
        {searchQuery
          ? splitQueryInString(title, searchQuery).map((substring, index) => (
              <span
                key={index}
                className={`${
                  substring.toLowerCase() === searchQuery.toLowerCase()
                    ? 'font-bold whitespace-pre-wrap'
                    : 'whitespace-pre-wrap'
                }`}
              >
                {substring}
              </span>
            ))
          : title}
      </div>
    </>
  )
}

export default observer(LinkedItemMeta)
