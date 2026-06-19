import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createEmbedNode } from '../../Lexical/Nodes/EmbedNode'

export const EmbedBlock = {
  name: 'Embed',
  iconName: 'open-in' as LexicalIconName,
  keywords: ['embed', 'iframe', 'video', 'youtube', 'vimeo', 'audio', 'web', 'media'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createEmbedNode())
    }),
}

export function GetEmbedBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(EmbedBlock.name, {
    iconName: EmbedBlock.iconName,
    keywords: EmbedBlock.keywords,
    onSelect: () => EmbedBlock.onSelect(editor),
  })
}
