import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createCalloutNode } from '../../Lexical/Nodes/CalloutNode'

export const CalloutBlock = {
  name: 'Callout',
  iconName: 'details-block' as LexicalIconName,
  keywords: ['callout', 'admonition', 'note', 'info', 'warning', 'tip', 'alert'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createCalloutNode())
    }),
}

export function GetCalloutBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(CalloutBlock.name, {
    iconName: CalloutBlock.iconName,
    keywords: CalloutBlock.keywords,
    onSelect: () => CalloutBlock.onSelect(editor),
  })
}
