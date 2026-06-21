import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createTweetEmbedNode } from '../../Lexical/Nodes/TweetEmbedNode'

export const TweetEmbedBlock = {
  name: 'Tweet',
  iconName: 'tweet' as LexicalIconName,
  keywords: ['tweet', 'x', 'twitter', 'post', 'embed', 'social'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTweetEmbedNode())
    }),
}

export function GetTweetEmbedBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(TweetEmbedBlock.name, {
    iconName: TweetEmbedBlock.iconName,
    keywords: TweetEmbedBlock.keywords,
    onSelect: () => TweetEmbedBlock.onSelect(editor),
  })
}
