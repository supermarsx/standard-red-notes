import { $getState, $setState, createState, ElementNode } from 'lexical'
import { $isListItemNode } from '@lexical/list'
import { $isCodeNode } from '@lexical/code'

// These native nodes omit ElementNode.__style from their JSON. Styled paragraph,
// heading and quote nodes already serialize it themselves.
const nativeBlockStyle = createState('srnBlockStyle', {
  parse: (value: unknown): string => {
    return typeof value === 'string' ? value : ''
  },
})
export const $readBlockStyle = (node: ElementNode): string =>
  node.getStyle() || ($isListItemNode(node) || $isCodeNode(node) ? $getState(node, nativeBlockStyle) : '')

export const $writeBlockStyle = (node: ElementNode, style: string): void => {
  node.setStyle(style)
  if ($isListItemNode(node) || $isCodeNode(node)) {
    $setState(node, nativeBlockStyle, style)
  }
}
