import { $insertNodes, LexicalEditor } from 'lexical'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createInlineMathNode } from '../../Lexical/Nodes/InlineMathNode'

export const InlineMathBlock = {
  name: 'Inline Equation',
  iconName: 'code' as LexicalIconName,
  keywords: ['inline math', 'inline equation', 'inline formula', 'latex', 'katex', 'tex'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodes([$createInlineMathNode()])
    }),
}

export function GetInlineMathBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(InlineMathBlock.name, {
    iconName: InlineMathBlock.iconName,
    keywords: InlineMathBlock.keywords,
    onSelect: () => InlineMathBlock.onSelect(editor),
  })
}
