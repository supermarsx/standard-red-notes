import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createPageBreakNode } from '../../Lexical/Nodes/PageBreakNode'

export const PageBreakBlock = {
  name: 'Page break',
  iconName: 'horizontal-rule' as LexicalIconName,
  keywords: ['page break', 'page', 'break', 'print', 'pagebreak'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createPageBreakNode())
    }),
}

export function GetPageBreakBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(PageBreakBlock.name, {
    iconName: PageBreakBlock.iconName,
    keywords: PageBreakBlock.keywords,
    onSelect: () => PageBreakBlock.onSelect(editor),
  })
}
