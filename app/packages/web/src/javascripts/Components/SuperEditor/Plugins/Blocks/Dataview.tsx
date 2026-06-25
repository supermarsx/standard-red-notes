import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createDataTableNode } from '../../Lexical/Nodes/DataTableNode'
import { achievements, METRICS } from '@/Achievements'

export const DataviewBlock = {
  name: 'Data Table',
  iconName: 'table' as LexicalIconName,
  keywords: ['dataview', 'data', 'table', 'grid', 'database', 'spreadsheet', 'rows', 'columns'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createDataTableNode())
      achievements.increment(METRICS.customTablesCreated)
    }),
}

export function GetDataviewBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(DataviewBlock.name, {
    iconName: DataviewBlock.iconName,
    keywords: DataviewBlock.keywords,
    onSelect: () => DataviewBlock.onSelect(editor),
  })
}
