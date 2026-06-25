import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createTableOfContentsNode } from '../../Lexical/Nodes/TableOfContentsNode'

export const TableOfContentsBlock = {
  name: 'Table of Contents',
  iconName: 'list-ol' as LexicalIconName,
  keywords: ['table of contents', 'toc', 'index', 'outline', 'headings', 'navigation', 'summary'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTableOfContentsNode())
    }),
}

export function GetTableOfContentsBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(TableOfContentsBlock.name, {
    iconName: TableOfContentsBlock.iconName,
    keywords: TableOfContentsBlock.keywords,
    onSelect: () => TableOfContentsBlock.onSelect(editor),
  })
}
