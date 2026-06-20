import { observer } from 'mobx-react-lite'
import ItemLinkAutocompleteInput from './ItemLinkAutocompleteInput'
import { LinkingController } from '@/Controllers/LinkingController'
import LinkedItemBubble from './LinkedItemBubble'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
        description: 'Link tags, notes, files',
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
  const ItemsToShowWhenCollapsed = 5
  const [isCollapsed, setIsCollapsed] = useState(
    itemsToDisplay.length < ItemsToShowWhenCollapsed ? false : isCollapsedByDefault,
  )

  // When collapsed, share the limited budget across both groups, prioritizing outgoing links.
  const visibleOutgoingLinks = isCollapsed ? outgoingLinks.slice(0, ItemsToShowWhenCollapsed) : outgoingLinks
  const remainingCollapsedBudget = Math.max(ItemsToShowWhenCollapsed - visibleOutgoingLinks.length, 0)
  const visibleBacklinks = isCollapsed ? backlinks.slice(0, remainingCollapsedBudget) : backlinks
  const nonVisibleItems =
    outgoingLinks.length - visibleOutgoingLinks.length + (backlinks.length - visibleBacklinks.length)

  const [canShowContainerToggle, setCanShowContainerToggle] = useState(true)
  const [linkContainer, setLinkContainer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const container = linkContainer
    if (!container) {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      const firstChild = container.firstElementChild
      if (!firstChild) {
        return
      }

      const threshold = firstChild.clientHeight + 4
      const didWrap = container.clientHeight > threshold

      if (didWrap) {
        setCanShowContainerToggle(true)
      } else {
        setCanShowContainerToggle(false)
      }
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [linkContainer])

  const shouldHideToggle = hideToggle || (!canShowContainerToggle && !isCollapsed)

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
        itemsToDisplay.length > 0 && !shouldHideToggle ? 'pt-2 ' + className.withToggle : undefined,
        isCollapsed ? 'gap-4' : 'gap-1',
        className.base,
      )}
    >
      <div
        className={classNames(
          'note-view-linking-container flex min-w-0 max-w-full items-center gap-2 bg-transparent md:min-w-80',
          allItemsLinkedToItem.length || notesLinkingToItem.length ? 'mt-1' : 'mt-0.5',
          isCollapsed ? 'overflow-x-auto' : 'flex-wrap',
          !shouldHideToggle && 'mr-2',
        )}
        ref={setLinkContainer}
      >
        {!!vault && <VaultNameBadge vault={vault} />}
        {!!lastEditedByContact && <LastEditedByBadge contact={lastEditedByContact} />}
        {noteFolder && (
          <button
            className={classNames(
              'group flex h-6 flex-shrink-0 cursor-pointer items-center rounded border border-border py-2 pl-1 pr-2',
              'align-middle text-sm text-text hover:bg-contrast focus:bg-contrast lg:text-xs',
            )}
            title={`Folder: ${noteFolder.title}`}
            onClick={() => {
              void navigationController.setSelectedFolder(noteFolder, { userTriggered: true })
            }}
          >
            <Icon type="folder" className="mr-1 flex-shrink-0 text-info" size="small" />
            <span className="overflow-hidden overflow-ellipsis whitespace-nowrap">{noteFolder.title}</span>
          </button>
        )}

        {(visibleOutgoingLinks.length > 0 || !readonly) && (
          <span className="flex flex-shrink-0 items-center gap-1" title="Items this note links to">
            <Icon type="link" className="flex-shrink-0 text-passive-1" size="small" />
            <span className={groupLabelClassName}>Links{outgoingLinks.length > 0 ? ` (${outgoingLinks.length})` : ''}</span>
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
            className="ml-1 flex flex-shrink-0 items-center gap-1 border-l border-border pl-2"
            title="Notes and files that link to this note"
          >
            <Icon type="link-off" className="flex-shrink-0 text-passive-1" size="small" />
            <span className={groupLabelClassName}>Linked By ({backlinks.length})</span>
          </span>
        )}
        {visibleBacklinks.map(renderBubble)}

        {isCollapsed && nonVisibleItems > 0 && <span className="flex-shrink-0">and {nonVisibleItems} more...</span>}
      </div>
      {itemsToDisplay.length > 0 && !shouldHideToggle && (
        <RoundIconButton
          id="toggle-linking-container"
          label="Toggle linked items container"
          onClick={() => {
            setIsCollapsed((isCollapsed) => !isCollapsed)
          }}
          icon={isCollapsed ? 'chevron-down' : 'chevron-left'}
        />
      )}
    </div>
  )
}

export default observer(LinkedItemBubblesContainer)
