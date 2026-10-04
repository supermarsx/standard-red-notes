import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createMermaidNode } from '../../Lexical/Nodes/MermaidNode'

export const MermaidBlock = {
  name: 'Mermaid Diagram',
  /**
   * Standard Red Notes: the node-graph glyph, not the generic `code` one this used
   * to borrow. `diagram` is `MermaidDiagramIcon`, registered in
   * `Components/Icon/LexicalIcons.tsx`. Line 2 of `GetMermaidBlockOption` below
   * reads this same field, so the Insert tab's "Diagrams & charts" catalog entry
   * and the slash picker both follow from this one value — and so does the Home
   * tab's Diagram-group button, which already names `diagram` directly.
   *
   * (`'code'` was never actually in the Lexical icon map either — the cast hid
   * that; it resolved through the MAIN icon map's `code` entry.)
   */
  iconName: 'diagram' as LexicalIconName,
  keywords: ['mermaid', 'diagram', 'graph', 'flowchart', 'sequence', 'chart', 'gantt', 'mindmap'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createMermaidNode())
    }),
}

export function GetMermaidBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(MermaidBlock.name, {
    iconName: MermaidBlock.iconName,
    keywords: MermaidBlock.keywords,
    onSelect: () => MermaidBlock.onSelect(editor),
  })
}
