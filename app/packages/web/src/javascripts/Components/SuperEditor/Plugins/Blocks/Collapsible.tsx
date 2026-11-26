import { LexicalEditor } from 'lexical'
import { INSERT_COLLAPSIBLE_COMMAND } from '../../Plugins/CollapsiblePlugin'
import { IconType } from '@standardnotes/snjs'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'

export const CollapsibleBlock = {
  name: 'Collapsible',
  iconName: 'details-block' as IconType,
  keywords: ['accordion', 'zone', 'section', 'collapse', 'collapsible', 'toggle'],
  onSelect: (editor: LexicalEditor) => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, { wrapSelection: true }),
}

export function GetCollapsibleBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(CollapsibleBlock.name, {
    iconName: CollapsibleBlock.iconName,
    keywords: CollapsibleBlock.keywords,
    onSelect: () => CollapsibleBlock.onSelect(editor),
  })
}
