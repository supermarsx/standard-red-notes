import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { IconType } from '@standardnotes/snjs'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { $createClockNode } from '../../Lexical/Nodes/ClockNode'

export const ClockBlock = {
  name: 'Clock',
  // Uses the existing `clock` icon from IconNameToSvgMapping (exact match).
  iconName: 'clock' as IconType,
  keywords: ['clock', 'time', 'timezone', 'world clock', 'date', 'now'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createClockNode())
    }),
}

export function GetClockBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(ClockBlock.name, {
    iconName: ClockBlock.iconName,
    keywords: ClockBlock.keywords,
    onSelect: () => ClockBlock.onSelect(editor),
  })
}
