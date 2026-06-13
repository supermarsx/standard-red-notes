import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createExcalidrawNode } from '../../Lexical/Nodes/ExcalidrawNode'

export const ExcalidrawBlock = {
  name: 'Drawing',
  iconName: 'editor' as LexicalIconName,
  keywords: ['excalidraw', 'drawing', 'draw', 'sketch', 'diagram', 'whiteboard', 'canvas'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createExcalidrawNode())
    }),
}

export function GetExcalidrawBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(ExcalidrawBlock.name, {
    iconName: ExcalidrawBlock.iconName,
    keywords: ExcalidrawBlock.keywords,
    onSelect: () => ExcalidrawBlock.onSelect(editor),
  })
}
