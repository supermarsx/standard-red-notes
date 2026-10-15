import { $isListNode } from '@lexical/list'
import { $createTextNode, $getRoot, $isElementNode, LexicalNode } from 'lexical'
import {
  $getChecklistDueAt,
  $getChecklistFlags,
  $getChecklistRecurrence,
  $isChecklistItemNode,
} from '../Lexical/Nodes/ChecklistItemNode'
import { checklistDueExportText } from './checklistDueDate'
import { checklistRecurrenceSummary } from './checklistRecurrence'

/**
 * Add a static deadline label to the disposable headless tree used by portable
 * text exports. Checklist metadata lives in NodeState, which the ordinary TXT,
 * Markdown, and HTML serializers cannot otherwise see.
 *
 * The projection is inserted before a nested list so a parent's deadline stays
 * attached to the parent label rather than appearing after its child tasks.
 */
export function $projectChecklistDueDatesForPortableExport(now = Date.now()): number {
  const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse()
  let projected = 0

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }

    if ($isChecklistItemNode(node)) {
      const dueAt = $getChecklistDueAt(node)
      const dueText = dueAt ? checklistDueExportText(dueAt, Boolean(node.getChecked()), now) : undefined
      const flags = $getChecklistFlags(node)
      const labels = [
        flags.pinned ? 'Pinned' : undefined,
        flags.priority !== 'normal' ? `${flags.priority === 'high' ? 'High' : 'Low'} priority` : undefined,
        dueText,
        checklistRecurrenceSummary($getChecklistRecurrence(node), true),
      ].filter(Boolean)
      if (labels.length) {
        const projection = $createTextNode(` - ${labels.join(' · ')}`)
        const nestedList = node.getChildren().find($isListNode)
        if (nestedList) {
          nestedList.insertBefore(projection)
        } else {
          node.append(projection)
        }
        projected += 1
      }
    }

    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }

  return projected
}
