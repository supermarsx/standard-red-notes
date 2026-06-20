import { SNTag } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useState } from 'react'
import RootTagDropZone from './RootTagDropZone'
import { TagListSectionType } from './TagListSection'
import { TagsListItem } from './TagsListItem'
import { useApplication } from '../ApplicationProvider'
import { useListKeyboardNavigation } from '@/Hooks/useListKeyboardNavigation'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'

type Props = {
  type: TagListSectionType
}

function getAllTagsForType(controller: NavigationController, type: TagListSectionType) {
  if (type === 'all') {
    if (controller.isSearching) {
      return controller.tags
    }
    return controller.allLocalRootTags
  }
  if (type === 'folders') {
    return controller.allLocalRootFolders
  }
  if (type === 'tags') {
    return controller.allLocalFlatTags
  }
  return controller.starredTags
}

const TagsList: FunctionComponent<Props> = ({ type }: Props) => {
  const application = useApplication()

  const allTags = getAllTagsForType(application.navigationController, type)

  const openTagContextMenu = useCallback(
    (x: number, y: number) => {
      application.navigationController.setContextMenuClickLocation({ x, y })
      application.navigationController.setContextMenuOpen(true)
    },
    [application],
  )

  const onContextMenu = useCallback(
    (tag: SNTag, section: TagListSectionType, posX: number, posY: number) => {
      application.navigationController.setContextMenuTag(tag, section)
      openTagContextMenu(posX, posY)
    },
    [application, openTagContextMenu],
  )

  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useListKeyboardNavigation(container, {
    initialFocus: 0,
    shouldAutoFocus: false,
    shouldWrapAround: false,
    resetLastFocusedOnBlur: true,
  })

  if (allTags.length === 0) {
    let emptyMessage: string
    if (application.navigationController.isSearching) {
      emptyMessage = 'No tags found. Try a different search.'
    } else if (type === 'folders') {
      emptyMessage = 'No folders yet. Create one with the + above.'
    } else if (type === 'tags') {
      emptyMessage = 'No tags yet. Create one with the + above.'
    } else {
      emptyMessage = 'No tags or folders. Create one using the add button above.'
    }
    return <div className="px-4 text-base opacity-50 lg:text-sm">{emptyMessage}</div>
  }

  return (
    <>
      <div ref={setContainer}>
        {allTags.map((tag) => {
          return (
            <TagsListItem
              level={0}
              key={tag.uuid}
              tag={tag}
              type={type}
              navigationController={application.navigationController}
              features={application.featuresController}
              linkingController={application.linkingController}
              onContextMenu={onContextMenu}
            />
          )
        })}
      </div>
      {type === 'folders' && <RootTagDropZone tagsState={application.navigationController} />}
    </>
  )
}

export default observer(TagsList)
