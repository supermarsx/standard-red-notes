import {
  FormEventHandler,
  ForwardedRef,
  KeyboardEventHandler,
  forwardRef,
  useDeferredValue,
  useEffect,
  useRef,
} from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { LinkingController } from '@/Controllers/LinkingController'
import { ElementIds } from '@/Constants/ElementIDs'
import { getLinkingSearchResults } from '@/Utils/Items/Search/getSearchResults'
import { useApplication } from '../ApplicationProvider'
import { DecryptedItem, SNNote } from '@standardnotes/snjs'
import { Combobox, ComboboxItem, ComboboxPopover, useComboboxStore, VisuallyHidden } from '@ariakit/react'
import LinkedItemMeta from './LinkedItemMeta'
import { LinkedItemSearchResultsAddTagOption } from './LinkedItemSearchResultsAddTagOption'
import { Slot } from '@radix-ui/react-slot'
import Icon from '../Icon/Icon'
import { PremiumFeatureIconName } from '../Icon/PremiumFeatureIcon'
import { KeyboardKey } from '@standardnotes/ui-services'
import { mergeRefs } from '@/Hooks/mergeRefs'

type Props = {
  linkingController: LinkingController
  focusPreviousItem: () => void
  focusedId: string | undefined
  setFocusedId: (id: string) => void
  hoverLabel?: string
  item: DecryptedItem
}

const ItemLinkAutocompleteInput = forwardRef(
  (
    { linkingController, focusPreviousItem, focusedId, setFocusedId, hoverLabel, item }: Props,
    forwardedRef: ForwardedRef<HTMLInputElement>,
  ) => {
    const application = useApplication()

    const { getLinkedTagsForItem, linkItems, createAndAddNewTag, isEntitledToNoteLinking } = linkingController

    const tagsLinkedToItem = getLinkedTagsForItem(item) || []

    const combobox = useComboboxStore()
    const value = combobox.useState('value')
    const searchQuery = useDeferredValue(value)

    const { unlinkedItems, shouldShowCreateTag } = getLinkingSearchResults(searchQuery, application, item)

    const inputRef = useRef<HTMLInputElement | null>(null)

    const onFormSubmit: FormEventHandler = async (event) => {
      event.preventDefault()
      if (searchQuery !== '') {
        await createAndAddNewTag(searchQuery)
        combobox.setValue('')
      }
    }

    const handleFocus = () => {
      if (focusedId !== ElementIds.ItemLinkAutocompleteInput) {
        setFocusedId(ElementIds.ItemLinkAutocompleteInput)
      }
    }

    const onKeyDown: KeyboardEventHandler = (event) => {
      switch (event.key) {
        case KeyboardKey.Left:
          if (searchQuery.length === 0) {
            focusPreviousItem()
          }
          break
      }
    }

    useEffect(() => {
      if (focusedId === ElementIds.ItemLinkAutocompleteInput) {
        inputRef.current?.focus()
      }
    }, [focusedId])

    return (
      <div>
        <form onSubmit={onFormSubmit}>
          <label>
            <VisuallyHidden>Link topics, notes or files</VisuallyHidden>
            <Combobox
              store={combobox}
              placeholder="Link topics, notes, files..."
              className={classNames(
                `${tagsLinkedToItem.length > 0 ? 'w-80' : 'mr-10 w-70'}`,
                'text-text focus:border-info h-7 w-70 bg-transparent text-sm focus:border-b-2 focus:shadow-none focus:outline-none lg:text-xs',
              )}
              title={hoverLabel}
              id={ElementIds.ItemLinkAutocompleteInput}
              ref={mergeRefs([inputRef, forwardedRef])}
              onFocus={handleFocus}
              onKeyDown={onKeyDown}
            />
          </label>
          <ComboboxPopover
            store={combobox}
            className={classNames(
              'z-dropdown-menu bg-default shadow-main max-h-[var(--popover-available-height)] w-[var(--popover-anchor-width)] overflow-y-auto rounded py-2',
              unlinkedItems.length === 0 && !shouldShowCreateTag && 'hidden',
            )}
          >
            {unlinkedItems.map((result) => {
              const cannotLinkItem = !isEntitledToNoteLinking && result instanceof SNNote

              return (
                <ComboboxItem
                  key={result.uuid}
                  className="hover:bg-contrast hover:text-foreground [&[data-active-item]]:bg-info-backdrop flex w-full cursor-pointer items-center justify-between gap-4 overflow-hidden px-3 py-2"
                  hideOnClick
                  onClick={() => {
                    linkItems(item, result).catch(console.error)
                    combobox.setValue('')
                  }}
                >
                  <LinkedItemMeta item={result} searchQuery={searchQuery} />
                  {cannotLinkItem && <Icon type={PremiumFeatureIconName} className="text-info ml-auto flex-shrink-0" />}
                </ComboboxItem>
              )
            })}
            {shouldShowCreateTag && (
              <ComboboxItem
                hideOnClick
                render={<Slot />}
                onClick={() => {
                  void createAndAddNewTag(searchQuery)
                  combobox.setValue('')
                }}
              >
                <LinkedItemSearchResultsAddTagOption searchQuery={searchQuery} />
              </ComboboxItem>
            )}
          </ComboboxPopover>
        </form>
      </div>
    )
  },
)

export default observer(ItemLinkAutocompleteInput)
