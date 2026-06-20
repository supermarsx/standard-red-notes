import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createGanttChartNode } from '../../Lexical/Nodes/GanttChartNode'

export const GanttChartBlock = {
  name: 'Gantt Chart',
  // No dedicated gantt/schedule icon exists in the icon set; `clock` is the
  // closest semantic match for a time-scheduled chart.
  iconName: 'clock' as LexicalIconName,
  keywords: ['gantt', 'chart', 'schedule', 'timeline', 'project', 'plan', 'tasks', 'roadmap', 'mermaid'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createGanttChartNode())
    }),
}

export function GetGanttChartBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(GanttChartBlock.name, {
    iconName: GanttChartBlock.iconName,
    keywords: GanttChartBlock.keywords,
    onSelect: () => GanttChartBlock.onSelect(editor),
  })
}
