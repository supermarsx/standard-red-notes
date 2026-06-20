import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createSqlQueryNode } from '../../Lexical/Nodes/SqlQueryNode'

export const SqlQueryBlock = {
  name: 'SQL Query',
  // No dedicated database icon exists in the icon set; `server` is the closest
  // semantic match for a (local) database query block.
  iconName: 'server' as LexicalIconName,
  keywords: ['sql', 'query', 'database', 'sqlite', 'table', 'select', 'data'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createSqlQueryNode())
    }),
}

export function GetSqlQueryBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(SqlQueryBlock.name, {
    iconName: SqlQueryBlock.iconName,
    keywords: SqlQueryBlock.keywords,
    onSelect: () => SqlQueryBlock.onSelect(editor),
  })
}
