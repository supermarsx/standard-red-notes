import {
  $getNodeByKey,
  $getRoot,
  $getState,
  $isElementNode,
  $setState,
  createState,
  ElementNode,
  LexicalNode,
} from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import { UuidGenerator } from '@standardnotes/utils'

// Node keys are session-local. This identity travels with headings through JSON,
// Yjs, renaming and section moves; it is assigned only when an order is edited.
const headingIdentity = createState('srnTocHeadingId', {
  parse: (value: unknown): string => (typeof value === 'string' && value.length <= 128 ? value : ''),
})
export type TocHeading = { key: string; id: string; text: string; level: number }
export type MoveDirection = -1 | 1

export function $readTocHeadings(includeBlank = false): TocHeading[] {
  const entries: TocHeading[] = []
  const visit = (node: ElementNode) => {
    for (const child of node.getChildren()) {
      if ($isHeadingNode(child) && (includeBlank || child.getTextContent().trim())) {
        entries.push({
          key: child.getKey(),
          id: $getState(child, headingIdentity),
          text: child.getTextContent().trim(),
          level: Number(child.getTag().slice(1)),
        })
      }
      if ($isElementNode(child)) {
        visit(child)
      }
    }
  }
  visit($getRoot())
  return entries
}

/** Copying a heading can copy its state: keep identities unique when saving an order. */
export function $identifyTocHeadings(): TocHeading[] {
  const seen = new Set<string>()
  return $readTocHeadings().map((heading) => {
    let id = heading.id
    if (!id || seen.has(id)) {
      id = UuidGenerator.GenerateUuid()
      $setState($getNodeByKey(heading.key)!, headingIdentity, id)
    }
    seen.add(id)
    return { ...heading, id }
  })
}

type Branch<T> = { entry: T; children: Branch<T>[] }
function branches<T extends TocHeading>(entries: T[]): Branch<T>[] {
  const roots: Branch<T>[] = []
  const stack: Branch<T>[] = []
  for (const entry of entries) {
    while (stack.length && stack[stack.length - 1].entry.level >= entry.level) {
      stack.pop()
    }
    const branch = { entry, children: [] }
    ;(stack.length ? stack[stack.length - 1].children : roots).push(branch)
    stack.push(branch)
  }
  return roots
}

/** Reorder sibling branches; children always remain beneath their own parent. */
export function orderTocHeadings<T extends TocHeading>(entries: T[], order: readonly string[]): T[] {
  if (!order.length) {
    return entries
  }
  const rank = new Map(order.map((id, index) => [id, index]))
  const flatten = (siblings: Branch<T>[]): T[] =>
    siblings
      .sort(
        (a, b) => (rank.get(a.entry.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.entry.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .flatMap(({ entry, children }) => [entry, ...flatten(children)])
  return flatten(branches(entries))
}

export function tocSibling(entries: TocHeading[], key: string, direction: MoveDirection): TocHeading | undefined {
  const find = (siblings: Branch<TocHeading>[]): TocHeading | undefined => {
    const index = siblings.findIndex(({ entry }) => entry.key === key)
    if (index >= 0) {
      const target = siblings[index + direction]?.entry
      // Moving across a different heading level could silently change parentage.
      return target?.level === siblings[index].entry.level ? target : undefined
    }
    for (const sibling of siblings) {
      const found = find(sibling.children)
      if (found) {
        return found
      }
    }
    return undefined
  }
  return find(branches(entries))
}

export function moveTocBranch(entries: TocHeading[], key: string, direction: MoveDirection): TocHeading[] | undefined {
  const target = tocSibling(entries, key, direction)
  if (!target) {
    return undefined
  }
  const sourceIndex = entries.findIndex((entry) => entry.key === key)
  const targetIndex = entries.indexOf(target)
  const end = (start: number) => {
    let index = start + 1
    while (index < entries.length && entries[index].level > entries[start].level) {
      index++
    }
    return index
  }
  const next = [...entries]
  const moved = next.splice(sourceIndex, end(sourceIndex) - sourceIndex)
  next.splice(direction < 0 ? targetIndex : end(targetIndex) - moved.length, 0, ...moved)
  return next
}

export function $noteSectionTargets(): Map<string, [string | undefined, string | undefined]> {
  const targets = new Map<string, [string | undefined, string | undefined]>()
  const visit = (siblings: Branch<TocHeading>[]) => {
    siblings.forEach(({ entry, children }, index) => {
      const eligible = (candidate: TocHeading | undefined) => {
        return candidate?.text &&
          candidate.level === entry.level &&
          $getNodeByKey(entry.key)?.getParent() === $getRoot() &&
          $getNodeByKey(candidate.key)?.getParent() === $getRoot()
          ? candidate.key
          : undefined
      }
      targets.set(entry.key, [eligible(siblings[index - 1]?.entry), eligible(siblings[index + 1]?.entry)])
      visit(children)
    })
  }
  visit(branches($readTocHeadings(true).filter(({ key }) => $getNodeByKey(key)?.getParent() === $getRoot())))
  return targets
}
export function $noteSectionTarget(key: string, direction: MoveDirection): string | undefined {
  return $noteSectionTargets().get(key)?.[direction < 0 ? 0 : 1]
}

/** Move existing model nodes, preserving content, formatting, selection and child sections. */
export function $moveNoteSection(key: string, direction: MoveDirection): boolean {
  const targetKey = $noteSectionTarget(key, direction)
  const heading = $getNodeByKey(key)
  const target = targetKey ? $getNodeByKey(targetKey) : null
  if (!$isHeadingNode(heading) || !$isHeadingNode(target)) {
    return false
  }
  const section = (start: typeof heading) => {
    const nodes: LexicalNode[] = [start]
    const level = Number(start.getTag().slice(1))
    let next = start.getNextSibling()
    while (next && !($isHeadingNode(next) && Number(next.getTag().slice(1)) <= level)) {
      nodes.push(next)
      next = next.getNextSibling()
    }
    return nodes
  }
  const moving = section(heading)
  if (direction < 0) {
    for (const node of moving) {
      target.insertBefore(node)
    }
  } else {
    let anchor = section(target).at(-1)!
    for (const node of moving) {
      anchor.insertAfter(node)
      anchor = node
    }
  }
  return true
}
