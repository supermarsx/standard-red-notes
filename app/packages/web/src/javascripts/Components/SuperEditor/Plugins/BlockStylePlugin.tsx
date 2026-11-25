import { useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $isElementNode, LexicalEditor } from 'lexical'
import { ListItemNode } from '@lexical/list'
import { CodeNode } from '@lexical/code'
import { mergeRegister } from '@lexical/utils'
import { isSafeCssValue } from '@/Utils/typographyProfiles'
import { parseStyleString } from './ToolbarPlugin/blockFormatting'
import { $readBlockStyle } from './ToolbarPlugin/persistedBlockStyle'

/** Native list items and code blocks do not render ElementNode.__style. Restore
 * only changed nodes, including initial JSON/Yjs hydration, without a document
 * walk on every keystroke. Styled paragraphs/headings/quotes render themselves. */
export function registerNativeBlockStyles(editor: LexicalEditor): () => void {
  const previous = new Map<string, { element: HTMLElement; style: Map<string, string> }>()
  return mergeRegister(
    ...[ListItemNode, CodeNode]
      .filter((node) => editor.hasNodes([node]))
      .map((node) =>
        editor.registerMutationListener(node, (mutations) => {
          editor.getEditorState().read(() => {
            for (const [key, mutation] of mutations) {
              if (mutation === 'destroyed') {
                previous.delete(key)
                continue
              }
              const block = $getNodeByKey(key)
              const element = editor.getElementByKey(key)
              if (!$isElementNode(block) || !element) {
                continue
              }
              const current = new Map(
                [...parseStyleString($readBlockStyle(block))].filter(
                  ([property, value]) =>
                    (/^[a-z-]+$/.test(property) || property === '--sn-profile-marker-color') && isSafeCssValue(value),
                ),
              )
              const before = previous.get(key)
              // Leave native alignment/indent reconciliation alone when the stored
              // style did not change (for example, after a manual alignment action).
              if (
                before &&
                before.element === element &&
                [...before.style].every(([property, value]) => current.get(property) === value) &&
                before.style.size === current.size
              ) {
                continue
              }
              for (const property of before?.style.keys() ?? []) {
                if (!current.has(property)) {
                  element.style.removeProperty(property)
                }
              }
              for (const [property, value] of current) {
                element.style.setProperty(property, value)
              }
              if (current.size > 0) {
                previous.set(key, { element, style: current })
              } else {
                previous.delete(key)
              }
            }
          })
        }),
      ),
  )
}

export default function BlockStylePlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerNativeBlockStyles(editor), [editor])
  return null
}
