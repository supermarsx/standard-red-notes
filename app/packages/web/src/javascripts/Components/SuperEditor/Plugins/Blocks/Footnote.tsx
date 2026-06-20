import { LexicalEditor } from 'lexical'
import { IconType } from '@standardnotes/snjs'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { INSERT_FOOTNOTE_COMMAND } from '../FootnotePlugin/FootnotePlugin'

export const FootnoteBlock = {
  name: 'Footnote',
  iconName: 'asterisk' as IconType,
  keywords: ['footnote', 'note', 'reference', 'citation', 'cite', 'annotation', 'superscript'],
  onSelect: (editor: LexicalEditor) => editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND, undefined),
}

export function GetFootnoteBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(FootnoteBlock.name, {
    iconName: FootnoteBlock.iconName,
    keywords: FootnoteBlock.keywords,
    onSelect: () => FootnoteBlock.onSelect(editor),
  })
}
