import { observer } from 'mobx-react-lite'
import ItemLinkAutocompleteInput from './ItemLinkAutocompleteInput'
import { LinkingController } from '@/Controllers/LinkingController'
import LinkedItemBubble from './LinkedItemBubble'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { ElementIds } from '@/Constants/ElementIDs'
import { classNames } from '@standardnotes/utils'
import { ContentType, DecryptedItemInterface, SNNote } from '@standardnotes/snjs'
import Icon from '../Icon/Icon'
import { LinkableItem } from '@/Utils/Items/Search/LinkableItem'
import { ItemLink } from '@/Utils/Items/Search/ItemLink'
import { FOCUS_TAGS_INPUT_COMMAND, keyboardStringForShortcut } from '@standardnotes/ui-services'
import { useItemLinks } from '@/Hooks/useItemLinks'
import RoundIconButton from '../Button/RoundIconButton'
import VaultNameBadge from '../Vaults/VaultNameBadge'
import LastEditedByBadge from '../Vaults/LastEditedByBadge'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import mergeRegister from '../../Hooks/mergeRegister'
import { useApplication } from '../ApplicationProvider'
import { shouldShowLinkedItemsToggle } from './linkedItemsToggle'

type Props = {
  linkingController: LinkingController
  item: DecryptedItemInterface
  hideToggle?: boolean
  readonly?: boolean
  className?: {
    base?: string
    withToggle?: string
  }
  isCollapsedByDefault?: boolean
}

type CollapseReason = 'item-count' | 'wrapped-layout'

const ItemsToShowWhenCollapsed = 5
const LayoutMeasurementTolerance = 4

const LinkedItemBubblesContainer = ({
  item,
  linkingController,
  hideToggle = false,
  readonly = false,
  className = {},
  isCollapsedByDefault = true,
}: Props) => {
  const { toggleAppPane } = useResponsiveAppPane()

  const application = useApplication()
  const keyboardService = application.keyboardService

  const { unlinkItems, activateItem } = linkingController
  const unlinkItem = useCallback(
    async (itemToUnlink: LinkableItem) => {
      void unlinkItems(item, itemToUnlink)
    },
    [item, unlinkItems],
  )

  const { notesLinkedToItem, filesLinkedToItem, tagsLinkedToItem, notesLinkingToItem, filesLinkingToItem } =
    useItemLinks(item)

  const navigationController = application.navigationController

  // The single folder the note currently lives in, rendered as a distinct chip below.
  // Folders are no longer tags, so the tag chip list needs no folder exclusion.
  const noteFolder = useMemo(
    () => (item instanceof SNNote ? navigationController.getNoteFolder(item) : undefined),
    [item, navigationController],
  )

  const allItemsLinkedToItem: ItemLink[] = useMemo(
    () => new Array<ItemLink>().concat(notesLinkedToItem, filesLinkedToItem, tagsLinkedToItem),
    [filesLinkedToItem, notesLinkedToItem, tagsLinkedToItem],
  )

  const linkInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const focusInput = () => {
      const input = linkInputRef.current
      if (input) {
        setTimeout(() => input.focus())
      }
    }
    return mergeRegister(
      keyboardService.addCommandHandler({
        command: FOCUS_TAGS_INPUT_COMMAND,
        category: 'Current note',
        description: 'Link topics, notes, files',
        onKeyDown: focusInput,
      }),
      application.commands.add('link-items-current', 'Link items to current note', focusInput, 'link'),
    )
  }, [application.commands, keyboardService])

  const shortcut = useMemo(
    () => keyboardStringForShortcut(keyboardService.keyboardShortcutForCommand(FOCUS_TAGS_INPUT_COMMAND)),
    [keyboardService],
  )

  const [focusedId, setFocusedId] = useState<string>()
  // Keep the focus order matching the visual order: outgoing links, the autocomplete input, then backlinks.
  const focusableIds = allItemsLinkedToItem
    .map((link) => link.id)
    .concat(
      [ElementIds.ItemLinkAutocompleteInput],
      notesLinkingToItem.map((link) => link.id),
      filesLinkingToItem.map((link) => link.id),
    )

  const focusPreviousItem = useCallback(() => {
    const currentFocusedIndex = focusableIds.findIndex((id) => id === focusedId)
    const previousIndex = currentFocusedIndex - 1

    if (previousIndex > -1) {
      setFocusedId(focusableIds[previousIndex])
    }
  }, [focusableIds, focusedId])

  const focusNextItem = useCallback(() => {
    const currentFocusedIndex = focusableIds.findIndex((id) => id === focusedId)
    const nextIndex = currentFocusedIndex + 1

    if (nextIndex < focusableIds.length) {
      setFocusedId(focusableIds[nextIndex])
    }
  }, [focusableIds, focusedId])

  const activateItemAndTogglePane = useCallback(
    async (item: LinkableItem) => {
      const paneId = await activateItem(item)
      if (paneId) {
        toggleAppPane(paneId)
      }
    },
    [activateItem, toggleAppPane],
  )

  const isItemBidirectionallyLinked = (link: ItemLink) => {
    const existsInAllItemLinks = !!allItemsLinkedToItem.find((item) => link.item.uuid === item.item.uuid)
    const existsInNotesLinkingToItem = !!notesLinkingToItem.find((item) => link.item.uuid === item.item.uuid)
    const existsInFilesLinkingToItem = !!filesLinkingToItem.find((item) => link.item.uuid === item.item.uuid)

    return (
      existsInAllItemLinks &&
      (link.item.content_type === ContentType.TYPES.Note ? existsInNotesLinkingToItem : existsInFilesLinkingToItem)
    )
  }

  // Outgoing links (this note -> others) and incoming links / backlinks (others -> this note),
  // kept as separate groups so both directions are clearly visible at a glance.
  const outgoingLinks = allItemsLinkedToItem
  const backlinks = useMemo(
    () => new Array<ItemLink>().concat(notesLinkingToItem, filesLinkingToItem),
    [notesLinkingToItem, filesLinkingToItem],
  )

  const itemsToDisplay = outgoingLinks.concat(backlinks)
  const [collapseReason, setCollapseReason] = useState<CollapseReason | undefined>(
    itemsToDisplay.length > ItemsToShowWhenCollapsed && isCollapsedByDefault ? 'item-count' : undefined,
  )
  const isCollapsed = collapseReason !== undefined

  // A count-driven collapse stops being useful as soon as every link fits inside
  // the collapsed item budget. Expand before hiding the toggle so the container
  // cannot become trapped in its horizontal, non-wrapping layout.
  useEffect(() => {
    if (collapseReason === 'item-count' && itemsToDisplay.length <= ItemsToShowWhenCollapsed) {
      setCollapseReason(undefined)
    }
  }, [collapseReason, itemsToDisplay.length])

  // When collapsed, share the limited budget across both groups, prioritizing outgoing links.
  const visibleOutgoingLinks = isCollapsed ? outgoingLinks.slice(0, ItemsToShowWhenCollapsed) : outgoingLinks
  const remainingCollapsedBudget = Math.max(ItemsToShowWhenCollapsed - visibleOutgoingLinks.length, 0)
  const visibleBacklinks = isCollapsed ? backlinks.slice(0, remainingCollapsedBudget) : backlinks
  const nonVisibleItems =
    outgoingLinks.length - visibleOutgoingLinks.length + (backlinks.length - visibleBacklinks.length)

  const [layoutCanCollapseMeaningfully, setLayoutCanCollapseMeaningfully] = useState(false)
  const [linkContainer, setLinkContainer] = useState<HTMLDivElement | null>(null)
  const linkContainerId = useId()
  const toggleId = `${linkContainerId}-toggle`
  useEffect(() => {
    const container = linkContainer
    if (!container) {
      return
    }

    const measureLayout = () => {
      const firstChild = container.firstElementChild
      if (!firstChild) {
        setLayoutCanCollapseMeaningfully(false)
        if (collapseReason === 'wrapped-layout') {
          setCollapseReason(undefined)
        }
        return
      }

      if (isCollapsed) {
        const collapsedRowOverflows = container.scrollWidth > container.clientWidth + LayoutMeasurementTolerance
        setLayoutCanCollapseMeaningfully(collapsedRowOverflows)

        // A layout-driven collapse is only meaningful while its single row
        // overflows. If a resize makes everything fit, restore the expanded
        // wrapping layout and remove the now-no-op control.
        if (collapseReason === 'wrapped-layout' && !collapsedRowOverflows) {
          setCollapseReason(undefined)
        }
        return
      }

      const expandedContainerWraps = container.clientHeight > firstChild.clientHeight + LayoutMeasurementTolerance
      setLayoutCanCollapseMeaningfully(expandedContainerWraps)
    }

    measureLayout()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureLayout)
      return () => {
        window.removeEventListener('resize', measureLayout)
      }
    }

    const resizeObserver = new ResizeObserver(measureLayout)

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [collapseReason, isCollapsed, itemsToDisplay.length, linkContainer])

  const canToggleContainer = shouldShowLinkedItemsToggle(
    itemsToDisplay.length,
    layoutCanCollapseMeaningfully,
    hideToggle,
  )

  const { vault, lastEditedByContact } = useItemVaultInfo(item)

  if (readonly && itemsToDisplay.length === 0 && !vault) {
    return null
  }

  const renderBubble = (link: ItemLink) => (
    <LinkedItemBubble
      link={link}
      key={link.id}
      activateItem={activateItemAndTogglePane}
      unlinkItem={unlinkItem}
      focusPreviousItem={focusPreviousItem}
      focusNextItem={focusNextItem}
      focusedId={focusedId}
      setFocusedId={setFocusedId}
      isBidirectional={isItemBidirectionallyLinked(link)}
      readonly={readonly}
    />
  )

  const groupLabelClassName = 'mr-0.5 flex-shrink-0 select-none text-xs font-semibold uppercase text-passive-1'

  return (
    <div
      className={classNames(
        'flex w-full flex-wrap justify-between md:flex-nowrap',
        itemsToDisplay.length > 0 && canToggleContainer ? 'pt-2 ' + className.withToggle : undefined,
        isCollapsed ? 'gap-4' : 'gap-1',
        className.base,
      )}
    >
      <div
        className={classNames(
          'note-view-linking-container flex max-w-full min-w-0 items-center gap-2 bg-transparent md:min-w-80',
          allItemsLinkedToItem.length || notesLinkingToItem.length ? 'mt-1' : 'mt-0.5',
          isCollapsed ? 'overflow-x-auto' : 'flex-wrap',
          canToggleContainer && 'mr-2',
        )}
        id={linkContainerId}
        ref={setLinkContainer}
      >
        {!!vault && <VaultNameBadge vault={vault} />}
        {!!lastEditedByContact && <LastEditedByBadge contact={lastEditedByContact} />}
        {noteFolder && (
          <button
            className={classNames(
              'group border-border flex h-6 flex-shrink-0 cursor-pointer items-center rounded border py-2 pr-2 pl-1',
              'text-text hover:bg-contrast focus:bg-contrast align-middle text-sm lg:text-xs',
            )}
            title={`Folder: ${noteFolder.title}`}
            onClick={() => {
              void navigationController.setSelectedFolder(noteFolder, { userTriggered: true })
            }}
          >
            <Icon type="folder" className="text-info mr-1 flex-shrink-0" size="small" />
            <span className="overflow-hidden overflow-ellipsis whitespace-nowrap">{noteFolder.title}</span>
          </button>
        )}

        {(visibleOutgoingLinks.length > 0 || !readonly) && (
          <span className="flex flex-shrink-0 items-center gap-1" title="Items this note links to">
            <Icon type="link" className="text-passive-1 flex-shrink-0" size="small" />
            <span className={groupLabelClassName}>
              Links{outgoingLinks.length > 0 ? ` (${outgoingLinks.length})` : ''}
            </span>
          </span>
        )}
        {visibleOutgoingLinks.map(renderBubble)}
        {!readonly && (
          <ItemLinkAutocompleteInput
            ref={linkInputRef}
            focusedId={focusedId}
            linkingController={linkingController}
            focusPreviousItem={focusPreviousItem}
            setFocusedId={setFocusedId}
            hoverLabel={`Focus input to add a link (${shortcut})`}
            item={item}
          />
        )}

        {backlinks.length > 0 && (
          <span
            className="border-border ml-1 flex flex-shrink-0 items-center gap-1 border-l pl-2"
            title="Notes and files that link to this note"
          >
            <Icon type="link-off" className="text-passive-1 flex-shrink-0" size="small" />
            <span className={groupLabelClassName}>Linked By ({backlinks.length})</span>
          </span>
        )}
        {visibleBacklinks.map(renderBubble)}

        {isCollapsed && nonVisibleItems > 0 && <span className="flex-shrink-0">and {nonVisibleItems} more...</span>}
      </div>
      {itemsToDisplay.length > 0 && canToggleContainer && (
        <RoundIconButton
          id={toggleId}
          className="note-view-linking-toggle"
          label={isCollapsed ? 'Expand linked items' : 'Collapse linked items'}
          aria-controls={linkContainerId}
          aria-expanded={!isCollapsed}
          onClick={() => {
            setCollapseReason((reason) => {
              if (reason) {
                return undefined
              }
              return itemsToDisplay.length > ItemsToShowWhenCollapsed ? 'item-count' : 'wrapped-layout'
            })
          }}
          icon={isCollapsed ? 'chevron-down' : 'chevron-up'}
        />
      )}
    </div>
  )
}

export default observer(LinkedItemBubblesContainer)
