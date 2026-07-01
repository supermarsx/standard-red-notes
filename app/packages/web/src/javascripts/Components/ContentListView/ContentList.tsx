import { WebApplication } from '@/Application/WebApplication'
import { KeyboardKey } from '@standardnotes/ui-services'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, KeyboardEventHandler, useCallback, useEffect, useRef } from 'react'
import { FOCUSABLE_BUT_NOT_TABBABLE } from '@/Constants/Constants'
import { ListableContentItem } from './Types/ListableContentItem'
import ContentListItem from './ContentListItem'
import { ElementIds } from '@/Constants/ElementIDs'
import { classNames } from '@standardnotes/utils'
import { SNTag } from '@standardnotes/snjs'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import { useMediaQuery, MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { VirtualizedList, VirtualizedListInterface } from './VirtualizedList'

type Props = {
  application: WebApplication
  items: ListableContentItem[]
  selectedUuids: ItemListController['selectedUuids']
}

const ContentList: FunctionComponent<Props> = ({ application, items, selectedUuids }) => {
  const { filesController, itemListController, navigationController, notesController } = application

  const { selectPreviousItem, selectNextItem } = itemListController
  const { hideTags, hideDate, hideNotePreview, hideEditorIcon } = itemListController.webDisplayOptions
  const { sortBy } = itemListController.displayOptions
  const selectedTag = navigationController.selected

  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const virtualListRef = useRef<VirtualizedListInterface | null>(null)

  // Standard Red Notes: register a scroll-to-uuid handler so the controller's
  // scrollToItem (used by selection, keyboard nav, new-note creation) can bring a
  // row into view even when the windowed list hasn't mounted it yet.
  useEffect(() => {
    itemListController.registerListScrollHandler((uuid, animated) => {
      const api = virtualListRef.current
      if (!api || !api.hasUuid(uuid)) {
        return false
      }
      api.scrollToUuid(uuid, animated ? 'smooth' : 'auto', 'nearest')
      return true
    })
    return () => {
      itemListController.registerListScrollHandler(undefined)
    }
  }, [itemListController])

  const onKeyDown: KeyboardEventHandler = useCallback(
    (e) => {
      if (e.key === KeyboardKey.Up) {
        e.preventDefault()
        selectPreviousItem()
      } else if (e.key === KeyboardKey.Down) {
        e.preventDefault()
        selectNextItem()
      }
    },
    [selectNextItem, selectPreviousItem],
  )

  const selectItem = useCallback(
    (item: ListableContentItem, userTriggered?: boolean) => {
      return itemListController.selectItem(item.uuid, userTriggered)
    },
    [itemListController],
  )

  const getTagsForItem = useCallback(
    (item: ListableContentItem) => {
      if (hideTags) {
        return []
      }

      if (!selectedTag) {
        return []
      }

      const tags = application.getItemTags(item)

      const isNavigatingOnlyTag = selectedTag instanceof SNTag && tags.length === 1
      if (isNavigatingOnlyTag) {
        return []
      }

      return tags
    },
    [hideTags, selectedTag, application],
  )

  const renderItem = useCallback(
    (item: ListableContentItem) => {
      return (
        <ContentListItem
          key={item.uuid}
          application={application}
          item={item}
          selected={selectedUuids.has(item.uuid)}
          hideDate={hideDate}
          hidePreview={hideNotePreview}
          hideTags={hideTags}
          hideIcon={hideEditorIcon}
          sortBy={sortBy}
          filesController={filesController}
          onSelect={selectItem}
          tags={getTagsForItem(item)}
          notesController={notesController}
        />
      )
    },
    [
      application,
      selectedUuids,
      hideDate,
      hideNotePreview,
      hideTags,
      hideEditorIcon,
      sortBy,
      filesController,
      selectItem,
      getTagsForItem,
      notesController,
    ],
  )

  return (
    <div
      ref={scrollContainerRef}
      className={classNames(
        'infinite-scroll overflow-y-auto overflow-x-hidden focus:shadow-none focus:outline-none',
        'md:max-h-full pointer-coarse:md:overflow-y-auto',
        'flex-grow',
        isMobileScreen ? !itemListController.isMultipleSelectionMode && 'pb-safe-bottom' : 'pb-2',
      )}
      id={ElementIds.ContentList}
      onKeyDown={onKeyDown}
      tabIndex={FOCUSABLE_BUT_NOT_TABBABLE}
    >
      {/*
        Standard Red Notes: the list is fully windowed and already receives the
        ENTIRE item set via `items`, so scroll-driven pagination (onNearEnd) is
        pure churn — every near-end scroll rebuilt `this.items` (a new array
        reference) and forced an O(N) offsets re-sum + O(N) selection scans on
        500k notes. The pagination apparatus (notesToDisplay/paginate/renderedItems)
        has been removed entirely; we deliberately do NOT forward onNearEnd.
      */}
      <VirtualizedList
        ref={virtualListRef}
        items={items}
        scrollContainerRef={scrollContainerRef}
        renderItem={renderItem}
      />
    </div>
  )
}

export default observer(ContentList)
