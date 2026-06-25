import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalTypeaheadMenuPlugin, useBasicTypeaheadTriggerMatch } from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { TextNode } from 'lexical'
import React, { useCallback, useMemo, useState } from 'react'
import useModal from '../../Lexical/Hooks/useModal'
import { InsertTableDialog } from '../../Plugins/TablePlugin'
import { BlockPickerOption } from './BlockPickerOption'
import { BlockPickerMenuItem } from './BlockPickerMenuItem'
import { GetDynamicPasswordBlocks } from '../Blocks/Password'
import { GetDynamicTableBlocks } from '../Blocks/Table'
import Popover from '@/Components/Popover/Popover'
import { isMobileScreen } from '@/Utils'
import { useApplication } from '@/Components/ApplicationProvider'
import { InsertRemoteImageDialog } from '../RemoteImagePlugin/RemoteImagePlugin'
import { GetIndentBlockOption, GetOutdentBlockOption } from '../Blocks/IndentOutdent'
import {
  GetCenterAlignBlockOption,
  GetJustifyAlignBlockOption,
  GetLeftAlignBlockOption,
  GetRightAlignBlockOption,
} from '../Blocks/Alignment'
import { OPEN_FILE_UPLOAD_MODAL_COMMAND } from '../EncryptedFilePlugin/FilePlugin'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { getFullBlockCatalog, BlockCatalogContext } from '../Blocks/blockCatalog'
import { useTranslation } from 'react-i18next'

export default function BlockPickerMenuPlugin({ popoverZIndex }: { popoverZIndex?: string }): React.JSX.Element {
  const { t } = useTranslation('editor')
  const [editor] = useLexicalComposerContext()
  const application = useApplication()
  const [modal, showModal] = useModal()
  const [queryString, setQueryString] = useState<string | null>(null)

  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  })

  const options = useMemo(() => {
    // Shared modal/command helpers the catalog's dialog-opening blocks need.
    const catalogContext: BlockCatalogContext = {
      openInsertTableDialog: () =>
        showModal(t('insertTable'), (onClose) => <InsertTableDialog activeEditor={editor} onClose={onClose} />),
      openInsertImageFromUrlDialog: () =>
        showModal(t('insertImageFromUrl'), (onClose) => <InsertRemoteImageDialog onClose={onClose} />),
      openFileUpload: () => editor.dispatchCommand(OPEN_FILE_UPLOAD_MODAL_COMMAND, undefined),
    }

    // The slash picker shares the toolbar Insert menu's single source of truth
    // (blockCatalog) so the two stay in parity. Indent/Outdent (mobile-only) and
    // the alignment shortcuts have no catalog entry, so they're appended here.
    const catalogOptions = getFullBlockCatalog(editor).map(
      (entry) =>
        new BlockPickerOption(entry.name, {
          iconName: entry.iconName as LexicalIconName,
          keywords: entry.keywords,
          onSelect: () => entry.onSelect(editor, catalogContext),
        }),
    )

    const indentOutdentOptions = application.isNativeMobileWeb()
      ? [GetIndentBlockOption(editor), GetOutdentBlockOption(editor)]
      : []

    const baseOptions = [
      ...catalogOptions,
      ...indentOutdentOptions,
      GetLeftAlignBlockOption(editor),
      GetCenterAlignBlockOption(editor),
      GetRightAlignBlockOption(editor),
      GetJustifyAlignBlockOption(editor),
    ]

    const dynamicOptions = [
      ...GetDynamicTableBlocks(editor, queryString || ''),
      ...GetDynamicPasswordBlocks(editor, queryString || ''),
    ]

    return queryString
      ? [
          ...dynamicOptions,
          ...baseOptions.filter((option) => {
            return new RegExp(queryString, 'gi').exec(option.title) || option.keywords != null
              ? option.keywords.some((keyword) => new RegExp(queryString, 'gi').exec(keyword))
              : false
          }),
        ]
      : baseOptions
  }, [editor, queryString, showModal, application, t])

  const onSelectOption = useCallback(
    (
      selectedOption: BlockPickerOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
      matchingString: string,
    ) => {
      editor.update(() => {
        if (nodeToRemove) {
          nodeToRemove.remove()
        }
        selectedOption.onSelect(matchingString)
        closeMenu()
      })
    },
    [editor],
  )

  return (
    <>
      {modal}
      <LexicalTypeaheadMenuPlugin<BlockPickerOption>
        onQueryChange={setQueryString}
        onSelectOption={onSelectOption}
        triggerFn={checkForTriggerMatch}
        options={options}
        menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
          if (!anchorElementRef.current || !options.length) {
            return null
          }

          return (
            <Popover
              title={t('blockPicker')}
              align="start"
              anchorElement={anchorElementRef.current}
              open={true}
              disableMobileFullscreenTakeover={true}
              side={isMobileScreen() ? 'top' : 'bottom'}
              maxHeight={(mh) => mh / 2}
              overrideZIndex={popoverZIndex}
            >
              <ul>
                {options.map((option, i: number) => (
                  <BlockPickerMenuItem
                    index={i}
                    isSelected={selectedIndex === i}
                    onClick={() => {
                      setHighlightedIndex(i)
                      selectOptionAndCleanUp(option)
                    }}
                    onMouseEnter={() => {
                      setHighlightedIndex(i)
                    }}
                    key={option.key}
                    option={option}
                  />
                ))}
              </ul>
            </Popover>
          )
        }}
      />
    </>
  )
}
