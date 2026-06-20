import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createTimelineNode } from '../../Lexical/Nodes/TimelineNode'

export const TimelineBlock = {
  name: 'Timeline',
  iconName: 'list-ul' as LexicalIconName,
  keywords: ['timeline', 'waterfall', 'gantt', 'schedule', 'roadmap', 'milestone', 'bar', 'chart'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTimelineNode())
    }),
}

export function GetTimelineBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(TimelineBlock.name, {
    iconName: TimelineBlock.iconName,
    keywords: TimelineBlock.keywords,
    onSelect: () => TimelineBlock.onSelect(editor),
  })
}
