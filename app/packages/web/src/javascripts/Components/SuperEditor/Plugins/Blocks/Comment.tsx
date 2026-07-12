import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createCommentNode } from '../../Lexical/Nodes/CommentNode'

export const CommentBlock = {
  name: 'Comment',
  iconName: 'comment' as LexicalIconName,
  keywords: ['comment', 'note', 'annotation', 'remark', 'feedback', 'aside'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createCommentNode())
    }),
}

export function GetCommentBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(CommentBlock.name, {
    iconName: CommentBlock.iconName,
    keywords: CommentBlock.keywords,
    onSelect: () => CommentBlock.onSelect(editor),
  })
}
