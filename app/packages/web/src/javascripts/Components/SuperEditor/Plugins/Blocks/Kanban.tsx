import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createKanbanNode } from '../../Lexical/Nodes/KanbanNode'

export const KanbanBlock = {
  name: 'Kanban Board',
  iconName: 'details-block' as LexicalIconName,
  keywords: ['kanban', 'board', 'column', 'card', 'task', 'todo', 'project'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createKanbanNode())
    }),
}

export function GetKanbanBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(KanbanBlock.name, {
    iconName: KanbanBlock.iconName,
    keywords: KanbanBlock.keywords,
    onSelect: () => KanbanBlock.onSelect(editor),
  })
}
