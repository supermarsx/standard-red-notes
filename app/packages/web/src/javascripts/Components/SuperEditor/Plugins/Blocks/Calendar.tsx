import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createCalendarNode } from '../../Lexical/Nodes/CalendarNode'

export const CalendarBlock = {
  name: 'Calendar',
  iconName: 'calendar' as LexicalIconName,
  keywords: ['calendar', 'month', 'date', 'event', 'schedule', 'agenda', 'day'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createCalendarNode())
    }),
}

export function GetCalendarBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(CalendarBlock.name, {
    iconName: CalendarBlock.iconName,
    keywords: CalendarBlock.keywords,
    onSelect: () => CalendarBlock.onSelect(editor),
  })
}
