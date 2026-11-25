import { useEffect, useRef, useState } from 'react'
import { $getNodeByKey, $getSelection, $isNodeSelection, $isRangeSelection, LexicalEditor } from 'lexical'
import { $isTableOfContentsNode } from '../../Lexical/Nodes/TableOfContentsNode'
import { ownSuperEditorElement } from '../../ownSuperEditorElements'

export function useSelectedTableOfContents(editor: LexicalEditor): string | null {
  const [key, setKey] = useState<string | null>(null)
  const previous = useRef<string | null>(null)
  useEffect(() => {
    const read = () =>
      editor.getEditorState().read(() => {
        const selection = $getSelection()
        const nodes = $isNodeSelection(selection)
          ? selection.getNodes()
          : $isRangeSelection(selection) && selection.isCollapsed()
            ? [selection.anchor.getNode()]
            : []
        const node = nodes.length === 1 && $isTableOfContentsNode(nodes[0]) ? nodes[0] : null
        const focused = editor.getRootElement()?.ownerDocument.activeElement
        const ribbon = focused?.closest('[data-toc-ribbon]')
        const ownsRibbon =
          ribbon &&
          ribbon.getAttribute('data-toc-ribbon') === previous.current &&
          ownSuperEditorElement(editor.getRootElement())?.contains(ribbon)
        // Native ribbon inputs own focus without replacing the selected block.
        const next =
          node?.getKey() ??
          (!selection && ownsRibbon && previous.current && $isTableOfContentsNode($getNodeByKey(previous.current))
            ? previous.current
            : null)
        if (next !== previous.current) {
          previous.current = next
          setKey(next)
        }
      })
    read()
    return editor.registerUpdateListener(read)
  }, [editor])
  return key
}
