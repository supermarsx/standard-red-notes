import { LexicalEditor } from 'lexical'
import { IconType } from '@standardnotes/snjs'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { INSERT_BOOKMARK_ANCHOR_COMMAND } from '../BookmarkPlugin/BookmarkPlugin'

/**
 * Insert ("/") menu entry that drops an inline bookmark anchor at the cursor.
 * Inserting via this menu mints a fresh anchor id; the matching bookmark record
 * is created from the editor command flow (see NoteView). Mirrors FootnoteBlock.
 */
export const BookmarkBlock = {
  name: 'Bookmark',
  iconName: 'pin' as IconType,
  keywords: ['bookmark', 'marker', 'mark', 'spot', 'anchor', 'note marker', 'jump'],
  onSelect: (editor: LexicalEditor) => editor.dispatchCommand(INSERT_BOOKMARK_ANCHOR_COMMAND, undefined),
}

export function GetBookmarkBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(BookmarkBlock.name, {
    iconName: BookmarkBlock.iconName,
    keywords: BookmarkBlock.keywords,
    onSelect: () => BookmarkBlock.onSelect(editor),
  })
}
