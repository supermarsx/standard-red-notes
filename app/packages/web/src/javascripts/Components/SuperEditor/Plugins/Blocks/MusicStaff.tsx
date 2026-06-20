import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createMusicStaffNode } from '../../Lexical/Nodes/MusicStaffNode'

export const MusicStaffBlock = {
  name: 'Music Staff',
  // `file-music` is the only music-related icon in the set; the closest match
  // for a musical staff / notation block.
  iconName: 'file-music' as LexicalIconName,
  keywords: ['music', 'staff', 'notation', 'abc', 'score', 'sheet', 'notes', 'melody', 'abcjs'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createMusicStaffNode())
    }),
}

export function GetMusicStaffBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(MusicStaffBlock.name, {
    iconName: MusicStaffBlock.iconName,
    keywords: MusicStaffBlock.keywords,
    onSelect: () => MusicStaffBlock.onSelect(editor),
  })
}
