import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createMermaidNode } from '../../Lexical/Nodes/MermaidNode'

export const MermaidBlock = {
  name: 'Mermaid Diagram',
  iconName: 'code' as LexicalIconName,
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
