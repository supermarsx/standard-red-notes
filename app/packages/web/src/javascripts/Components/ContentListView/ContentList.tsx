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

/**
 * Standard Red Notes: the row height the windowed list should assume for rows it
 * has not yet rendered, derived from the display options that actually decide a
 * row's height rather than from one hard-coded number.
 *
 * Measured in Chrome against the real stylesheet (fresh Tailwind, 420px notes
 * column, 300 notes with a realistic mix of titles and previews), as the mean
 * of all 300 rendered rows:
 *
 *   | date | preview | measured row heights | MEAN  | this model |
 *   |------|---------|----------------------|-------|------------|
 *   | yes  | yes     | 60.5 - 113.5         |  79.3 |     79     |
 *   | no   | yes     | 44.0 -  95.5         |  61.5 |     62     |
 *   | yes  | no      | 60.5 -  95.5         |  63.7 |     64     |
 *   | no   | no      | 44.0 -  77.5         |  47.0 |     47     |
 *
 * i.e. a single-line row with neither optional line is 47px, the date line adds
 * ~17px and the preview line ~15px, and that decomposition reproduces every
 * measured mean to within 0.7px. The previous behaviour was to pass nothing and
 * let the list assume 60 for all four — which is not a central value in any of
 * them: it is the FLOOR of two and 28% above the mean of another.
 *
 * These are bootstrap values, not a commitment: VirtualizedList replaces them
 * with the running mean of the rows it has really measured as soon as it has
 * measured any, so content whose titles wrap more often than this sample (or a
 * future row redesign) corrects itself instead of silently mis-sizing the
 * scrollbar. They only have to be right for the first render.
 */
const ESTIMATED_ROW_HEIGHT_BASE_PX = 47
const ESTIMATED_ROW_HEIGHT_DATE_PX = 17
const ESTIMATED_ROW_HEIGHT_PREVIEW_PX = 15

function estimatedRowHeight(hideDate: boolean, hidePreview: boolean): number {
  return (
    ESTIMATED_ROW_HEIGHT_BASE_PX +
    (hideDate ? 0 : ESTIMATED_ROW_HEIGHT_DATE_PX) +
    (hidePreview ? 0 : ESTIMATED_ROW_HEIGHT_PREVIEW_PX)
  )
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
        'infinite-scroll overflow-x-hidden overflow-y-auto focus:shadow-none focus:outline-none',
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
        estimatedItemHeight={estimatedRowHeight(!!hideDate, !!hideNotePreview)}
        renderItem={renderItem}
      />
    </div>
  )
}

export default observer(ContentList)
