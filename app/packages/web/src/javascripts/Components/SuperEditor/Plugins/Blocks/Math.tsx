import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createMathNode } from '../../Lexical/Nodes/MathNode'

export const MathBlock = {
  name: 'Equation',
  iconName: 'code' as LexicalIconName,
  keywords: ['math', 'equation', 'formula', 'latex', 'katex', 'tex', 'block math'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createMathNode())
    }),
}

export function GetMathBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(MathBlock.name, {
    iconName: MathBlock.iconName,
    keywords: MathBlock.keywords,
    onSelect: () => MathBlock.onSelect(editor),
  })
}
