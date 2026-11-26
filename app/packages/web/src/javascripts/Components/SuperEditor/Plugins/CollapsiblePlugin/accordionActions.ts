import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  LexicalNode,
} from 'lexical'
import { $findMatchingParent, $insertNodeToNearestRoot } from '@lexical/utils'
import { $createCollapsibleContainerNode } from './CollapsibleContainerNode'
import { $createCollapsibleContentNode } from './CollapsibleContentNode'
import { $createCollapsibleTitleNode } from './CollapsibleTitleNode'

export type AccordionOptions = { title?: string; open?: boolean; wrapSelection?: boolean }

/** Whole selected blocks keep their node identity, formatting, widgets and task metadata. */
export function $insertAccordion(options: AccordionOptions = {}): boolean {
  const selection = $getSelection()
  const blocks: LexicalNode[] = []
  if (options.wrapSelection && $isRangeSelection(selection) && !selection.isCollapsed()) {
    const selected = new Set(
      selection
        .getNodes()
        .map((node) => $findMatchingParent(node, (candidate) => $isRootOrShadowRoot(candidate.getParent())))
        .filter((node): node is LexicalNode => node !== null),
    )
    const start = selection.isBackward() ? selection.focus : selection.anchor
    const end = selection.isBackward() ? selection.anchor : selection.focus
    const first = $findMatchingParent(start.getNode(), (node) => $isRootOrShadowRoot(node.getParent()))
    const last = $findMatchingParent(end.getNode(), (node) => $isRootOrShadowRoot(node.getParent()))
    let boundaryNode = end.getNode()
    let atBlockStart = end.offset === 0
    while (atBlockStart) {
      if (!last || boundaryNode.is(last)) {
        break
      }
      if (boundaryNode.getPreviousSibling()) {
        atBlockStart = false
      }
      const parent = boundaryNode.getParent()
      if (!parent) {
        atBlockStart = false
        break
      }
      boundaryNode = parent
    }
    if (atBlockStart && first !== last && last) {
      selected.delete(last)
    }
    const parent = [...selected][0]?.getParent()
    if (!parent || [...selected].some((node) => !node.getParent()?.is(parent))) {
      return false
    }
    blocks.push(...parent.getChildren().filter((node) => selected.has(node)))
    if (!blocks.length) {
      return false
    }
  }
  const title = $createTextNode(options.title?.trim().slice(0, 256) || 'Accordion section')
  const content = $createCollapsibleContentNode()
  const container = $createCollapsibleContainerNode(options.open !== false).append(
    $createCollapsibleTitleNode().append($createParagraphNode().append(title)),
    content,
  )
  if (blocks.length) {
    blocks[0].insertBefore(container)
    content.append(...blocks)
  } else {
    content.append($createParagraphNode())
    $insertNodeToNearestRoot(container)
  }
  title.select(0, title.getTextContentSize())
  return true
}
