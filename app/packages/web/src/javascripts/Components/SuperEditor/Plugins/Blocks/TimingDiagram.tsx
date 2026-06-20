import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createTimingDiagramNode } from '../../Lexical/Nodes/TimingDiagramNode'

export const TimingDiagramBlock = {
  name: 'Timing Diagram',
  // No dedicated waveform/signal icon exists in the icon set; `line-width` reads
  // as horizontal signal lines, the closest semantic match for a digital
  // timing/waveform diagram.
  iconName: 'line-width' as LexicalIconName,
  keywords: ['timing', 'diagram', 'waveform', 'wave', 'signal', 'clock', 'digital', 'wavedrom', 'hardware'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTimingDiagramNode())
    }),
}

export function GetTimingDiagramBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(TimingDiagramBlock.name, {
    iconName: TimingDiagramBlock.iconName,
    keywords: TimingDiagramBlock.keywords,
    onSelect: () => TimingDiagramBlock.onSelect(editor),
  })
}
