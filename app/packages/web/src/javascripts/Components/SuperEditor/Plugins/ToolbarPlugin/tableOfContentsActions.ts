import { $getNodeByKey, EditorUpdateOptions, HISTORY_PUSH_TAG, LexicalEditor, SKIP_DOM_SELECTION_TAG } from 'lexical'
import { $isTableOfContentsNode, TableOfContentsFormat } from '../../Lexical/Nodes/TableOfContentsNode'
import {
  $identifyTocHeadings,
  $moveNoteSection,
  $readTocHeadings,
  MoveDirection,
  moveTocBranch,
  orderTocHeadings,
} from '../../Lexical/Utils/tableOfContentsOutline'

const options: EditorUpdateOptions = { discrete: true, tag: [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG] }
export function changeTableOfContents(editor: LexicalEditor, key: string, patch: Partial<TableOfContentsFormat>): void {
  editor.update(() => {
    const node = $getNodeByKey(key)
    if (editor.isEditable() && $isTableOfContentsNode(node)) {
      node.setFormat(patch)
    }
  }, options)
}
export function moveContentsEntry(
  editor: LexicalEditor,
  tocKey: string,
  headingKey: string,
  direction: MoveDirection,
): void {
  editor.update(() => {
    const node = $getNodeByKey(tocKey)
    if (!editor.isEditable() || !$isTableOfContentsNode(node)) {
      return
    }
    const order = node.getFormat().entryOrder
    if (!moveTocBranch(orderTocHeadings($readTocHeadings(), order), headingKey, direction)) {
      return
    }
    const entries = orderTocHeadings($identifyTocHeadings(), order)
    const next = moveTocBranch(entries, headingKey, direction)
    if (next) {
      node.setFormat({ entryOrder: next.map(({ id }) => id) })
    }
  }, options)
}
export function moveContentsNoteSection(
  editor: LexicalEditor,
  tocKey: string,
  headingKey: string,
  direction: MoveDirection,
): void {
  editor.update(() => {
    if (editor.isEditable() && $isTableOfContentsNode($getNodeByKey(tocKey))) {
      $moveNoteSection(headingKey, direction)
    }
  }, options)
}
