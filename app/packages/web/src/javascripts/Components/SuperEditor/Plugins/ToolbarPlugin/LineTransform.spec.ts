/**
 * @jest-environment jsdom
 *
 * Headless-editor tests for the Super editor's line sort/dedupe tree mutation.
 * These exercise the REAL Lexical tree (paragraphs + list items), not just the
 * pure ordering helper, so we know the toolbar action actually reorders blocks
 * and drops duplicates in the document.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode } from '@lexical/rich-text'
import { $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, LexicalNode } from 'lexical'
import { $createHeadingNode } from '@lexical/rich-text'

import { $collectSelectedLineBlocks, $transformSelectedLines } from './LineTransform'
import { LineOperation } from './LineOperations'

const editor = createHeadlessEditor({
  namespace: 'LineTransformTest',
  nodes: [ListNode, ListItemNode, HeadingNode],
  onError: (error) => {
    throw error
  },
})

const setParagraphs = (lines: string[]): void => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      for (const line of lines) {
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode(line))
        root.append(paragraph)
      }
    },
    { discrete: true },
  )
}

const setBulletList = (lines: string[]): void => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const list = $createListNode('bullet')
      for (const line of lines) {
        const item = $createListItemNode()
        item.append($createTextNode(line))
        list.append(item)
      }
      root.append(list)
    },
    { discrete: true },
  )
}

/** Select the entire document (root element span, so even empty blocks are included) and run the op. */
const runOverAll = (operation: LineOperation): boolean => {
  let changed = false
  editor.update(
    () => {
      const root = $getRoot()
      const selection = $createRangeSelection()
      selection.anchor.set(root.getKey(), 0, 'element')
      selection.focus.set(root.getKey(), root.getChildrenSize(), 'element')
      changed = $transformSelectedLines(selection, operation)
    },
    { discrete: true },
  )
  return changed
}

const readLines = (): string[] =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .flatMap((block) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const children = (block as any).getChildren?.() as LexicalNode[] | undefined
        if (children && children.length > 0 && children.every((c) => 'getChildren' in c)) {
          // a container (e.g. a list) — read each item
          return children.map((item) => item.getTextContent())
        }
        return [block.getTextContent()]
      }),
  )

describe('$transformSelectedLines over paragraphs', () => {
  it('sorts paragraphs digits-first ascending', () => {
    setParagraphs(['banana', '2nd', 'apple', '10things'])
    const changed = runOverAll('digits-first-asc')
    expect(changed).toBe(true)
    const lines = readLines()
    expect(lines.indexOf('10things')).toBeLessThan(lines.indexOf('2nd'))
    expect(lines.indexOf('2nd')).toBeLessThan(lines.indexOf('apple'))
    expect(lines).toHaveLength(4)
  })

  it('reverse flips paragraph order and keeps the block count', () => {
    setParagraphs(['one', 'two', 'three'])
    runOverAll('reverse')
    expect(readLines()).toEqual(['three', 'two', 'one'])
  })

  it('dedupe removes duplicate paragraph blocks', () => {
    setParagraphs(['a', 'b', 'a', 'c', 'b'])
    const changed = runOverAll('dedupe')
    expect(changed).toBe(true)
    expect(readLines()).toEqual(['a', 'b', 'c'])
  })

  it('natural sort orders embedded numbers numerically', () => {
    setParagraphs(['item10', 'item2', 'item1'])
    runOverAll('natural-asc')
    expect(readLines()).toEqual(['item1', 'item2', 'item10'])
  })

  it('returns false (no-op) for a single block', () => {
    setParagraphs(['only one'])
    expect(runOverAll('digits-first-asc')).toBe(false)
    expect(readLines()).toEqual(['only one'])
  })

  it('returns false when already sorted (no document change)', () => {
    setParagraphs(['a', 'b', 'c'])
    expect(runOverAll('digits-first-asc')).toBe(false)
  })
})

describe('$transformSelectedLines over list items', () => {
  it('sorts list items and excludes the list container itself', () => {
    setBulletList(['cherry', 'apple', 'banana'])
    const changed = runOverAll('letters-first-asc')
    expect(changed).toBe(true)
    expect(readLines()).toEqual(['apple', 'banana', 'cherry'])
  })

  it('dedupes list items', () => {
    setBulletList(['x', 'y', 'x'])
    runOverAll('dedupe')
    expect(readLines()).toEqual(['x', 'y'])
  })
})

describe('$transformSelectedLines edge cases', () => {
  it('sorts an empty line (paragraph) ahead of content and keeps the block count', () => {
    setParagraphs(['banana', '', 'apple'])
    runOverAll('digits-first-asc')
    expect(readLines()).toEqual(['', 'apple', 'banana'])
  })

  it('collapses duplicate blocks down to the distinct set, removing the surplus', () => {
    setParagraphs(['x', 'x', 'x', 'y'])
    const changed = runOverAll('dedupe')
    expect(changed).toBe(true)
    const lines = readLines()
    expect(lines).toEqual(['x', 'y'])
    // surplus blocks were actually removed from the document
    expect(editor.getEditorState().read(() => $getRoot().getChildren().length)).toBe(2)
  })

  it('dedupes whitespace-only lines that are byte-identical', () => {
    setParagraphs(['  ', 'a', '  '])
    runOverAll('dedupe')
    expect(readLines()).toEqual(['  ', 'a'])
  })

  it('reorders text across mixed block types while preserving each block kind in place', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const heading = $createHeadingNode('h1')
        heading.append($createTextNode('zeta'))
        root.append(heading)
        const p1 = $createParagraphNode()
        p1.append($createTextNode('alpha'))
        root.append(p1)
        const p2 = $createParagraphNode()
        p2.append($createTextNode('mu'))
        root.append(p2)
      },
      { discrete: true },
    )
    runOverAll('letters-first-asc')
    // text is reordered (alpha, mu, zeta)…
    expect(readLines()).toEqual(['alpha', 'mu', 'zeta'])
    // …but the first block stays a heading (block kinds are not reordered, only text)
    const firstType = editor.getEditorState().read(() => $getRoot().getFirstChild()?.getType())
    expect(firstType).toBe('heading')
  })
})

describe('$collectSelectedLineBlocks', () => {
  it('collects each paragraph once, in document order', () => {
    setParagraphs(['p1', 'p2', 'p3'])
    let keys: string[] = []
    let texts: string[] = []
    editor.update(
      () => {
        const blocks = $getRoot().getChildren()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstText = (blocks[0] as any).getFirstChild()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lastText = (blocks[blocks.length - 1] as any).getLastChild()
        const selection = $createRangeSelection()
        selection.anchor.set(firstText.getKey(), 0, 'text')
        selection.focus.set(lastText.getKey(), lastText.getTextContent().length, 'text')
        const collected = $collectSelectedLineBlocks(selection)
        keys = collected.map((block) => block.getKey())
        texts = collected.map((block) => block.getTextContent())
      },
      { discrete: true },
    )
    expect(texts).toEqual(['p1', 'p2', 'p3'])
    expect(new Set(keys).size).toBe(3) // no duplicates
  })
})
