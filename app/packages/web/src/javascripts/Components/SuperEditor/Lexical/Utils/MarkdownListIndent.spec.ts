/** @jest-environment jsdom */

/**
 * Markdown list-indent normalisation, proved at BOTH ends.
 *
 * The unit tests pin the rewritten text, and the import tests run the real
 * `@lexical/markdown` conversion and read the DEPTH of each row out of the
 * resulting Lexical tree — because the defect was never visible in the markdown,
 * only in the tree it produced: with `LIST_INDENT_SIZE = 4` hard-coded in
 * `node_modules`, two-space input arrived as `0,0,1,1`.
 *
 * Depth is read structurally, counting the nested `list` nodes above a row, and
 * Lexical's text-less nesting WRAPPER list items are skipped — they are
 * structure, not rows.
 */

import { createHeadlessEditor } from '@lexical/headless'
import { $convertFromMarkdownString } from '@lexical/markdown'
import { $getRoot } from 'lexical'
import { MarkdownTransformers } from '../../MarkdownTransformers'
import { SuperExportNodes } from '../Nodes/AllNodes'
import BlocksEditorTheme from '../Theme/Theme'
import {
  detectMarkdownListIndentUnit,
  MARKDOWN_LIST_INDENT_SIZE,
  normalizeMarkdownListIndentation,
} from './MarkdownListIndent'

type SerializedNode = { type?: string; children?: SerializedNode[]; text?: string; checked?: boolean }

type ImportedRow = { text: string; depth: number; checked?: boolean }

const ownText = (node: SerializedNode): string =>
  (node.children ?? [])
    .filter((child) => child.type !== 'list')
    .map((child) => (child.type === 'text' ? (child.text ?? '') : ownText(child)))
    .join('')

/** `{ text, depth, checked }` for every real row of a serialized tree. */
const rowsOf = (root: SerializedNode): ImportedRow[] => {
  const rows: ImportedRow[] = []
  const walk = (node: SerializedNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'list') {
        walk(child, depth + 1)
        continue
      }
      if (child.type === 'listitem' || child.type === 'checklist-item') {
        const children = child.children ?? []
        const nested = children.filter((grandChild) => grandChild.type === 'list')
        // A text-less wrapper is structure; it contributes its branch, not a row.
        if (!(children.length > 0 && nested.length === children.length)) {
          rows.push({ text: ownText(child), depth, checked: child.checked })
        }
        for (const branch of nested) {
          walk(branch, depth + 1)
        }
        continue
      }
      walk(child, depth)
    }
  }
  walk(root, -1)
  return rows
}

/** Convert `markdown` with the real transformer and read its rows back. */
const convertedRows = (markdown: string): ImportedRow[] => {
  const editor = createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => {
      throw error
    },
    nodes: SuperExportNodes,
  })
  editor.update(
    () => {
      $getRoot().clear()
      $convertFromMarkdownString(markdown, MarkdownTransformers, undefined, true)
    },
    { discrete: true },
  )
  const state = JSON.parse(JSON.stringify(editor.getEditorState().toJSON())) as { root: SerializedNode }
  return rowsOf(state.root)
}

/** The real import path: normalise, then convert. */
const importRows = (markdown: string): ImportedRow[] => convertedRows(normalizeMarkdownListIndentation(markdown))

const FOUR_LEVELS = [
  { text: 'a', depth: 0, checked: false },
  { text: 'b', depth: 1, checked: true },
  { text: 'c', depth: 2, checked: false },
  { text: 'd', depth: 3, checked: true },
]

describe('detectMarkdownListIndentUnit', () => {
  it('reads the unit the document itself uses', () => {
    expect(detectMarkdownListIndentUnit('- a\n  - b\n    - c\n')).toBe(2)
    expect(detectMarkdownListIndentUnit('- a\n   - b\n      - c\n')).toBe(3)
    expect(detectMarkdownListIndentUnit('- a\n    - b\n        - c\n')).toBe(4)
    expect(detectMarkdownListIndentUnit('- a\n        - b\n')).toBe(8)
  })

  it('reads nothing from a flat list or a tab-indented one', () => {
    expect(detectMarkdownListIndentUnit('- a\n- b\n')).toBeUndefined()
    expect(detectMarkdownListIndentUnit('- a\n\t- b\n\t\t- c\n')).toBeUndefined()
    expect(detectMarkdownListIndentUnit('Just a paragraph.\n')).toBeUndefined()
  })

  it('floors the unit at two spaces, because one space is not a convention', () => {
    // CommonMark reads a one-space indent as a sibling, not a child, and so does
    // the transformer today. Calling it a unit would nest a whole document.
    expect(detectMarkdownListIndentUnit('- a\n - b\n')).toBe(2)
  })
})

describe('normalizeMarkdownListIndentation', () => {
  it('restates two-space nesting in the four spaces the transformer reads', () => {
    expect(normalizeMarkdownListIndentation('- [ ] a\n  - [x] b\n    - [ ] c\n')).toBe(
      '- [ ] a\n    - [x] b\n        - [ ] c\n',
    )
  })

  it('returns four-space input unchanged, as the same string', () => {
    const already = '- a\n    - b\n        - c\n'
    expect(normalizeMarkdownListIndentation(already)).toBe(already)
  })

  it('leaves a four-space document byte-identical, ragged rows included', () => {
    // Input that already imported correctly must come out UNTOUCHED, not merely
    // equivalent: the six-space row keeps its six spaces. The transformer already
    // reads it as level 1 (`floor(6/4)`), so rewriting it to four would change
    // the bytes of a document this function has no business editing.
    const already = ['- a', '    - b', '      - ragged', '        - c', ''].join('\n')
    expect(normalizeMarkdownListIndentation(already)).toBe(already)
  })

  it('returns flat and tab-indented input unchanged', () => {
    const flat = '1. one\n2. two\n'
    expect(normalizeMarkdownListIndentation(flat)).toBe(flat)
    const tabbed = '- a\n\t- b\n\t\t- c\n'
    expect(normalizeMarkdownListIndentation(tabbed)).toBe(tabbed)
  })

  it('rewrites only the leading whitespace, never the row itself', () => {
    expect(normalizeMarkdownListIndentation('- a *b* `  c  `\n  - [x] d  e  \n')).toBe(
      '- a *b* `  c  `\n    - [x] d  e  \n',
    )
  })

  it('leaves a fenced code block alone, markers and all', () => {
    const input = ['- a', '  - b', '', '```md', '- fenced', '  - fenced child', '```', '  - c', ''].join('\n')
    expect(normalizeMarkdownListIndentation(input)).toBe(
      ['- a', '    - b', '', '```md', '- fenced', '  - fenced child', '```', '    - c', ''].join('\n'),
    )
  })

  it('does not let a ~~~ fence close a ``` one', () => {
    const input = ['```', '  - still fenced', '~~~', '  - also still fenced', '```', '  - real row', ''].join('\n')
    expect(normalizeMarkdownListIndentation(input)).toBe(
      ['```', '  - still fenced', '~~~', '  - also still fenced', '```', '    - real row', ''].join('\n'),
    )
  })

  it('mirrors the transformer own indent size rather than hard-coding a second one', () => {
    expect(MARKDOWN_LIST_INDENT_SIZE).toBe(4)
    expect(normalizeMarkdownListIndentation('- a\n  - b\n')).toContain(' '.repeat(MARKDOWN_LIST_INDENT_SIZE) + '- b')
  })
})

describe('markdown import depth, through the real transformer', () => {
  it('two-space input keeps all four levels', () => {
    expect(importRows('- [ ] a\n  - [x] b\n    - [ ] c\n      - [x] d\n')).toEqual(FOUR_LEVELS)
  })

  it('four-space input is unaffected', () => {
    expect(importRows('- [ ] a\n    - [x] b\n        - [ ] c\n            - [x] d\n')).toEqual(FOUR_LEVELS)
  })

  it('tab-indented input keeps all four levels', () => {
    expect(importRows('- [ ] a\n\t- [x] b\n\t\t- [ ] c\n\t\t\t- [x] d\n')).toEqual(FOUR_LEVELS)
  })

  it('three-space input keeps all four levels', () => {
    expect(importRows('- [ ] a\n   - [x] b\n      - [ ] c\n         - [x] d\n')).toEqual(FOUR_LEVELS)
  })

  it('counts a tab as a whole level in a document that also uses spaces', () => {
    // Mixed indentation: the unit comes from the space-indented rows (2), and a
    // tab-indented row is one level on its own, which is how the transformer
    // reads a tab already. Dropping the tab would strand `c` at the root.
    expect(importRows('- [ ] a\n  - [x] b\n\t- [ ] c\n')).toEqual([
      { text: 'a', depth: 0, checked: false },
      { text: 'b', depth: 1, checked: true },
      { text: 'c', depth: 1, checked: false },
    ])
  })

  it('a ragged row is floored to the level below it, not promoted past it', () => {
    // Unit 2 (the smallest step in the document). Three spaces is deeper than
    // `b`'s marker but short of a second step, so it is `b`'s sibling — which is
    // how CommonMark resolves it too. Five spaces clears the next step, so it is
    // a child.
    expect(importRows('- [ ] a\n  - [x] b\n   - [ ] c\n     - [x] d\n')).toEqual([
      { text: 'a', depth: 0, checked: false },
      { text: 'b', depth: 1, checked: true },
      { text: 'c', depth: 1, checked: false },
      { text: 'd', depth: 2, checked: true },
    ])
  })

  it('half-flattens without the normalisation, which is the defect', () => {
    // The same input straight into the transformer: `0,1,2,3` became `0,0,1,1`.
    // Asserted against the un-normalised path so the fix is measured, not
    // compared with itself.
    const twoSpace = ['- [ ] a', '  - [x] b', '    - [ ] c', '      - [x] d', ''].join('\n')
    expect(convertedRows(twoSpace).map((row) => row.depth)).toEqual([0, 0, 1, 1])
    expect(importRows(twoSpace).map((row) => row.depth)).toEqual([0, 1, 2, 3])
  })
})
