import {
  CANCEL_SEARCH_COMMAND,
  CREATE_NEW_NOTE_KEYBOARD_COMMAND,
  keyboardStringForShortcut,
  NEXT_LIST_ITEM_KEYBOARD_COMMAND,
  PREVIOUS_LIST_ITEM_KEYBOARD_COMMAND,
  SEARCH_KEYBOARD_COMMAND,
  SELECT_ALL_ITEMS_KEYBOARD_COMMAND,
} from '@standardnotes/ui-services'
import { WebApplication } from '@/Application/WebApplication'
import { PANEL_NAME_NOTES } from '@/Constants/Constants'
import { FileItem, Platform, PrefKey, WebAppEvent } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ContentList from '@/Components/ContentListView/ContentList'
import Spinner from '@/Components/Spinner/Spinner'
import { ElementIds } from '@/Constants/ElementIDs'
import ContentListHeader from './Header/ContentListHeader'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import SearchBar from '../SearchBar/SearchBar'
import { classNames } from '@standardnotes/utils'
import { useFileDragNDrop } from '../FileDragNDropProvider'
import DailyContentList from './Daily/DailyContentList'
import { ListableContentItem } from './Types/ListableContentItem'
import { PanelResizedData } from '@/Types/PanelResizedData'
import FloatingAddButton from './FloatingAddButton'
import ContentTableView from '../ContentTableView/ContentTableView'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { PaneLayout } from '@/Controllers/PaneController/PaneLayout'
import { viewTabOwnsCreateShortcut } from '@/Controllers/PaneController/ViewTab'
import { usePaneSwipeGesture } from '../Panes/usePaneGesture'
import { mergeRefs } from '@/Hooks/mergeRefs'
import Icon from '../Icon/Icon'
import MobileMultiSelectionToolbar from './MobileMultiSelectionToolbar'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import QuickActionsBar from '../QuickActions/QuickActionsBar'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: React.ReactNode
  onPanelWidthLoad: (width: number) => void
}

const ContentListView = forwardRef<HTMLDivElement, Props>(
  ({ application, className, id, children, onPanelWidthLoad }, ref) => {
    const { t } = useTranslation('notes')
    const {
      paneController,
      itemListController,
      navigationController,
      searchOptionsController,
      linkingController,
      notesController,
    } = application

    const { setPaneLayout, panes } = useResponsiveAppPane()

    const { selected: selectedTag, selectedAsTag } = navigationController
    const {
      completedFullSync,
      createNewNote,
      optionsSubtitle,
      panelTitle,
      items,
      isCurrentNoteTemplate,
      isTableViewEnabled,
      selectedUuids,
      selectNextItem,
      selectPreviousItem,
    } = itemListController

    const innerRef = useRef<HTMLDivElement | null>(null)

    const { addDragTarget, removeDragTarget } = useFileDragNDrop()

    useEffect(() => {
      return application.addWebEventObserver((event, data) => {
        if (event === WebAppEvent.PanelResized) {
          const { panel, width } = data as PanelResizedData
          if (panel === PANEL_NAME_NOTES) {
            if (selectedAsTag) {
              void navigationController.setPanelWidthForTag(selectedAsTag, width)
            } else {
              void application.setPreference(PrefKey.NotesPanelWidth, width).catch(console.error)
            }
          }
        }
      })
    }, [application, navigationController, selectedAsTag])

    useEffect(() => {
      const panelWidth = selectedTag?.preferences?.panelWidth || application.getPreference(PrefKey.NotesPanelWidth)
      if (panelWidth) {
        onPanelWidthLoad(panelWidth)
      }
    }, [selectedTag, application, onPanelWidthLoad])

    const fileDropCallback = useCallback(
      async (file: FileItem) => {
        const currentTag = navigationController.selected

        if (!currentTag) {
          return
        }

        if (navigationController.isInAnySystemView() || navigationController.isInSmartView()) {
          console.error('Trying to link uploaded files to smart view')
          return
        }

        await linkingController.linkItems(file, currentTag)
      },
      [navigationController, linkingController],
    )

    useEffect(() => {
      const target = innerRef.current
      const currentTag = navigationController.selected
      // Normal tags (and folders) accept tag-linking drops.
      const shouldAddDropTarget =
        !navigationController.isInAnySystemView() && !navigationController.isInSmartView() && Boolean(currentTag)

      if (target && shouldAddDropTarget) {
        addDragTarget(target, {
          tooltipText: t('dropFilesToUpload', { title: currentTag?.title ?? '' }),
          callback: fileDropCallback,
        })
      }

      return () => {
        if (target) {
          removeDragTarget(target)
        }
      }
    }, [
      addDragTarget,
      fileDropCallback,
      navigationController,
      navigationController.selected,
      removeDragTarget,
      innerRef,
      t,
    ])

    const icon = selectedTag?.iconString

    const filteredItems = items

    const addNewItem = useCallback(async () => {
      await createNewNote(undefined, undefined, undefined, true)
      setPaneLayout(PaneLayout.Editing)
    }, [createNewNote, setPaneLayout])

    const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
    const shouldUseTableView = isTableViewEnabled && !isMobileScreen

    useEffect(() => {
      const searchBarElement = document.getElementById(ElementIds.SearchBar)
      /**
       * In the browser we're not allowed to override cmd/ctrl + n, so we have to
       * use Control modifier as well. These rules don't apply to desktop, but
       * probably better to be consistent.
       */
      return application.keyboardService.addCommandHandlers([
        {
          command: NEXT_LIST_ITEM_KEYBOARD_COMMAND,
          category: 'Notes list',
          description: 'Go to next item',
          elements: [document.body, ...(searchBarElement ? [searchBarElement] : [])],
          onKeyDown: () => {
            if (searchBarElement === document.activeElement) {
              searchBarElement?.blur()
            }
            if (shouldUseTableView) {
              return
            }
            selectNextItem()
          },
        },
        {
          command: PREVIOUS_LIST_ITEM_KEYBOARD_COMMAND,
          category: 'Notes list',
          description: 'Go to previous item',
          element: document.body,
          onKeyDown: () => {
            if (shouldUseTableView) {
              return
            }
            selectPreviousItem()
          },
        },
        {
          command: SEARCH_KEYBOARD_COMMAND,
          category: 'General',
          description: 'Toggle global search',
          onKeyDown: (event) => {
            if (searchBarElement) {
              event.preventDefault()
              searchBarElement.focus()
            }
          },
        },
        {
          command: CANCEL_SEARCH_COMMAND,
          onKeyDown: () => {
            if (searchBarElement) {
              searchBarElement.blur()
            }
          },
        },
        {
          command: SELECT_ALL_ITEMS_KEYBOARD_COMMAND,
          category: 'General',
          description: 'Select all items',
          onKeyDown: (event) => {
            const isTargetInsideContentList = (event.target as HTMLElement).closest(`#${ElementIds.ContentList}`)

            if (!isTargetInsideContentList) {
              return
            }

            event.preventDefault()
            itemListController.selectAll()
          },
        },
      ])
    }, [
      addNewItem,
      application.keyboardService,
      createNewNote,
      itemListController,
      selectNextItem,
      selectPreviousItem,
      shouldUseTableView,
    ])

    const shortcutForCreate = useMemo(
      () => application.keyboardService.keyboardShortcutForCommand(CREATE_NEW_NOTE_KEYBOARD_COMMAND),
      [application],
    )

    const addButtonLabel = useMemo(() => {
      let shortcut = keyboardStringForShortcut(shortcutForCreate)
      if (shortcut) {
        shortcut = '(' + shortcut + ')'
      }
      return t('createNoteInTopicWithShortcut', { shortcut })
    }, [shortcutForCreate, t])

    // Stand down while a view tab binds the create shortcut to its own action (the
    // Files tab makes it "upload file"), so only one handler is ever installed.
    const createShortcutOwnedByViewTab = viewTabOwnsCreateShortcut(paneController.activeViewTab)

    useEffect(() => {
      if (createShortcutOwnedByViewTab) {
        return
      }
      return application.commands.addWithShortcut(
        CREATE_NEW_NOTE_KEYBOARD_COMMAND,
        'General',
        'Create new note',
        (event) => {
          event?.preventDefault()
          void addNewItem()
        },
        'add',
      )
    }, [addNewItem, application.commands, createShortcutOwnedByViewTab])

    const dailyMode = selectedAsTag?.isDailyEntry

    const handleDailyListSelection = useCallback(
      async (item: ListableContentItem, userTriggered: boolean) => {
        await itemListController.selectItemWithScrollHandling(item, {
          userTriggered: true,
          scrollIntoView: userTriggered === false,
          animated: false,
        })
      },
      [itemListController],
    )

    useEffect(() => {
      const hasEditorPane = panes.includes(AppPaneId.Editor)
      if (!hasEditorPane) {
        innerRef.current?.style.removeProperty('width')
      }
    }, [selectedUuids, innerRef, isCurrentNoteTemplate, filteredItems, panes])

    const [setElement] = usePaneSwipeGesture('right', () => setPaneLayout(PaneLayout.TagSelection), {
      requiresStartFromEdge: application.platform !== Platform.Android,
    })

    return (
      <div
        id={id}
        className={classNames(className, 'sn-component section pt-safe-top h-full overflow-hidden')}
        aria-label={t('notesAndFiles')}
        ref={mergeRefs([ref, innerRef, setElement])}
      >
        {isMobileScreen && !itemListController.isMultipleSelectionMode && (
          <FloatingAddButton onClick={addNewItem} label={addButtonLabel} style={dailyMode ? 'danger' : 'info'} />
        )}
        <div id="items-title-bar" className="section-title-bar border-border border-b border-solid">
          <div id="items-title-bar-container">
            {selectedTag && (
              <ContentListHeader
                application={application}
                panelTitle={panelTitle}
                icon={icon}
                addButtonLabel={addButtonLabel}
                addNewItem={addNewItem}
                isTableViewEnabled={isTableViewEnabled}
                optionsSubtitle={optionsSubtitle}
                selectedTag={selectedTag}
                itemListController={itemListController}
                paneController={paneController}
              />
            )}
            {(!shouldUseTableView || isMobileScreen) && (
              <SearchBar
                application={application}
                itemListController={itemListController}
                searchOptionsController={searchOptionsController}
                hideOptions={shouldUseTableView}
              />
            )}
          </div>
        </div>
        {!itemListController.isMultipleSelectionMode && <QuickActionsBar application={application} />}
        {itemListController.isMultipleSelectionMode && (
          <div className="border-border flex items-center border-b border-l-2 border-l-transparent py-2.5 pr-4">
            <div className="px-4">
              <StyledTooltip label={t('selectAllItems')} showOnHover showOnMobile>
                <button
                  className="border-border hover:bg-contrast ml-auto rounded border p-1"
                  onClick={() => {
                    itemListController.selectAll()
                  }}
                >
                  <Icon type="select-all" size="medium" />
                </button>
              </StyledTooltip>
            </div>
            <div className="text-base font-semibold md:text-sm">
              {t('selectedCount', { count: itemListController.selectedItemsCount })}
            </div>
            <StyledTooltip label={t('cancelMultipleSelection')} showOnHover showOnMobile>
              <button
                className="border-border hover:bg-contrast ml-auto rounded border p-1"
                onClick={() => {
                  itemListController.cancelMultipleSelection()
                }}
              >
                <Icon type="close" size="medium" />
              </button>
            </StyledTooltip>
          </div>
        )}
        {selectedAsTag && dailyMode && (
          <DailyContentList
            items={items}
            selectedTag={selectedAsTag}
            selectedUuids={selectedUuids}
            itemListController={itemListController}
            onSelect={handleDailyListSelection}
          />
        )}
        {!dailyMode && completedFullSync && !filteredItems.length ? (
          <p className="empty-items-list opacity-50">{t('noItems')}</p>
        ) : null}
        {!dailyMode && !completedFullSync && !filteredItems.length ? (
          <div className="empty-items-list gap-2 opacity-50" role="status" aria-busy="true" aria-live="polite">
            <Spinner className="h-5 w-5" />
            <span>{t('loading')}</span>
          </div>
        ) : null}
        {!dailyMode && filteredItems.length ? (
          shouldUseTableView ? (
            <ContentTableView items={filteredItems} application={application} />
          ) : (
            <ContentList items={filteredItems} selectedUuids={selectedUuids} application={application} />
          )
        ) : null}
        {isMobileScreen && itemListController.isMultipleSelectionMode && (
          <MobileMultiSelectionToolbar notesController={notesController} navigationController={navigationController} />
        )}
        <div className="h-safe-bottom absolute bottom-0 w-full" />
        {children}
      </div>
    )
  },
)

export default observer(ContentListView)
