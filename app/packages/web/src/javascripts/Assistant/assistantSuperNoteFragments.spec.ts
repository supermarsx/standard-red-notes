import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes } from '@lexical/html'
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { BlockEditorNodes } from '@/Components/SuperEditor/Lexical/Nodes/AllNodes'
import BlocksEditorTheme from '@/Components/SuperEditor/Lexical/Theme/Theme'
import { createAssistantMarkdownFragmentNodes, createAssistantRichFragmentNodes } from './assistantSuperNoteFragments'

type Node = Record<string, unknown> & { children?: Node[] }

const ensureCrypto = () => {
  if (!globalThis.TextEncoder) {
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
  }
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
}

const flatten = (nodes: Node[]): Node[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])

const documentWith = (children: Node[]) => ({
  root: {
    children,
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

describe('assistant Super-note rich fragments', () => {
  beforeAll(ensureCrypto)

  it('uses the canonical Markdown importer for native headings, marks, links, code, nested lists, and checks', () => {
    let todo = 0
    const nodes = createAssistantMarkdownFragmentNodes(
      [
        '## Styled title',
        '',
        '**Bold** and *italic* with [safe link](https://example.com/docs).',
        '',
        '> Quoted guidance',
        '',
        '```ts',
        'const answer = 42',
        '```',
        '',
        '- Parent',
        '    - Nested',
        '',
        '- [ ] Verify Philips E24E2',
      ].join('\n'),
      () => `todo-imported-${++todo}`,
    ) as Node[]

    const all = flatten(nodes)
    expect(all.some((node) => ['heading', 'heading-styled'].includes(String(node.type)) && node.tag === 'h2')).toBe(
      true,
    )
    expect(all.some((node) => ['quote', 'quote-styled'].includes(String(node.type)))).toBe(true)
    expect(all.some((node) => node.type === 'code' && node.language === 'ts')).toBe(true)
    expect(all.some((node) => node.type === 'link' && node.url === 'https://example.com/docs')).toBe(true)
    expect(all.some((node) => node.type === 'text' && node.text === 'Bold' && (Number(node.format) & 1) === 1)).toBe(
      true,
    )
    expect(all.some((node) => node.type === 'text' && node.text === 'italic' && (Number(node.format) & 2) === 2)).toBe(
      true,
    )
    expect(all.filter((node) => node.type === 'list').length).toBeGreaterThanOrEqual(2)
    expect(all.some((node) => node.type === 'listitem' && node.children?.some((child) => child.type === 'list'))).toBe(
      true,
    )
    expect(
      all.some(
        (node) =>
          node.type === 'listitem' &&
          node.checked === false &&
          (node.$ as { srnChecklistTodoId?: string } | undefined)?.srnChecklistTodoId === 'todo-imported-1',
      ),
    ).toBe(true)

    const text = JSON.stringify(documentWith(nodes))
    const editor = createHeadlessEditor({
      namespace: 'AssistantFragmentRoundTrip',
      theme: BlocksEditorTheme,
      editable: false,
      nodes: BlockEditorNodes,
      onError: (error) => {
        throw error
      },
    })
    editor.setEditorState(editor.parseEditorState(text))
    let html = ''
    editor.getEditorState().read(() => {
      html = $generateHtmlFromNodes(editor)
    })
    expect(html).toContain('<h2')
    expect(html).toContain('<strong')
    expect(html).toContain('<em')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('<pre')

    const saved = JSON.stringify(editor.getEditorState().toJSON())
    const reloaded = createHeadlessEditor({
      namespace: 'AssistantFragmentReload',
      theme: BlocksEditorTheme,
      editable: false,
      nodes: BlockEditorNodes,
      onError: (error) => {
        throw error
      },
    })
    expect(() => reloaded.setEditorState(reloaded.parseEditorState(saved))).not.toThrow()
    expect(flatten((JSON.parse(saved) as { root: { children: Node[] } }).root.children)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: expect.stringMatching(/^heading(?:-styled)?$/), tag: 'h2' }),
        expect.objectContaining({ type: 'code', language: 'ts' }),
      ]),
    )
  })

  it('builds explicit underline/strikethrough/link styles and sanitizes unsafe URLs and CSS', () => {
    const nodes = createAssistantRichFragmentNodes(
      [
        {
          type: 'heading',
          level: 2,
          content: [
            {
              text: 'Philips E24E2 deployment',
              marks: ['bold', 'underline', 'strikethrough'],
              style: 'color: #b91c1c;',
              link: 'javascript:alert(1)',
            },
          ],
        },
      ],
      () => 'unused',
    ) as Node[]
    const link = flatten(nodes).find((node) => node.type === 'link')
    const text = flatten(nodes).find((node) => node.type === 'text')

    expect(link?.url).toBe('https://')
    expect(Number(text?.format) & 1).toBe(1)
    expect(Number(text?.format) & 4).toBe(4)
    expect(Number(text?.format) & 8).toBe(8)
    expect(text?.style).toBe('color: #b91c1c;')
    expect(() =>
      createAssistantRichFragmentNodes(
        [{ type: 'paragraph', content: [{ text: 'bad', style: 'background:url(javascript:alert(1))' }] }],
        () => 'unused',
      ),
    ).toThrow(/unsafe CSS/)
  })
})

/**
 * List nesting in an assistant-written Markdown fragment.
 *
 * This is the common case, not an edge: a language model nests lists with two
 * spaces by default, and `@lexical/markdown` reads one level as four, so a
 * four-level plan used to arrive as `0,1,1,2` — the same loss the export side
 * had, reached by a different road.
 *
 * Depth is read structurally from the returned Lexical node JSON, counting the
 * `list` nodes above each row, and Lexical's text-less nesting WRAPPER list
 * items are skipped: they are structure, not rows. (`sanitizeImportedNode` uses
 * the same discriminator to decide which rows get a todo id.)
 */
describe('assistant Markdown fragment list nesting', () => {
  beforeAll(ensureCrypto)

  type FragmentNode = { type?: string; children?: FragmentNode[]; text?: string; checked?: boolean }

  const ownText = (node: FragmentNode): string =>
    (node.children ?? [])
      .filter((child) => child.type !== 'list')
      .map((child) => (child.type === 'text' ? (child.text ?? '') : ownText(child)))
      .join('')

  /** `{ text, depth, checked }` for every real row the fragment produced. */
  const rowsOf = (markdown: string): { text: string; depth: number; checked?: boolean }[] => {
    let todo = 0
    const nodes = createAssistantMarkdownFragmentNodes(markdown, () => `todo-nesting-${++todo}`)
    const rows: { text: string; depth: number; checked?: boolean }[] = []
    const walk = (node: FragmentNode, depth: number): void => {
      for (const child of node.children ?? []) {
        if (child.type === 'list') {
          walk(child, depth + 1)
          continue
        }
        if (child.type === 'listitem' || child.type === 'checklist-item') {
          const children = child.children ?? []
          const nested = children.filter((grandChild) => grandChild.type === 'list')
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
    walk({ children: nodes as unknown as FragmentNode[] }, -1)
    return rows
  }

  const FOUR_LEVELS = [
    { text: 'a', depth: 0, checked: false },
    { text: 'b', depth: 1, checked: true },
    { text: 'c', depth: 2, checked: false },
    { text: 'd', depth: 3, checked: true },
  ]

  it('keeps all four levels of the two-space nesting a model writes by default', () => {
    expect(rowsOf(['- [ ] a', '  - [x] b', '    - [ ] c', '      - [x] d'].join('\n'))).toEqual(FOUR_LEVELS)
  })

  it('leaves four-space nesting exactly as deep as it was', () => {
    expect(rowsOf(['- [ ] a', '    - [x] b', '        - [ ] c', '            - [x] d'].join('\n'))).toEqual(FOUR_LEVELS)
  })

  it('keeps all four levels of tab nesting', () => {
    expect(rowsOf(['- [ ] a', '\t- [x] b', '\t\t- [ ] c', '\t\t\t- [x] d'].join('\n'))).toEqual(FOUR_LEVELS)
  })

  it('keeps all four levels of three-space nesting', () => {
    expect(rowsOf(['- [ ] a', '   - [x] b', '      - [ ] c', '         - [x] d'].join('\n'))).toEqual(FOUR_LEVELS)
  })

  it('counts a tab as a whole level in a fragment that also uses spaces', () => {
    expect(rowsOf(['- [ ] a', '  - [x] b', '\t- [ ] c'].join('\n'))).toEqual([
      { text: 'a', depth: 0, checked: false },
      { text: 'b', depth: 1, checked: true },
      { text: 'c', depth: 1, checked: false },
    ])
  })

  it('floors a ragged row to the level below it rather than past it', () => {
    // Unit 2, the smallest step in the fragment. Three spaces is deeper than
    // `b`'s marker but short of a second step, so it is `b`'s sibling; five
    // spaces clears the step, so it is a child.
    expect(rowsOf(['- [ ] a', '  - [x] b', '   - [ ] c', '     - [x] d'].join('\n'))).toEqual([
      { text: 'a', depth: 0, checked: false },
      { text: 'b', depth: 1, checked: true },
      { text: 'c', depth: 1, checked: false },
      { text: 'd', depth: 2, checked: true },
    ])
  })

  it('does not restate indentation inside a fenced code block', () => {
    let todo = 0
    const nodes = createAssistantMarkdownFragmentNodes(
      ['- a', '  - b', '', '```md', '- fenced', '  - fenced child', '```'].join('\n'),
      () => `todo-fenced-${++todo}`,
    ) as FragmentNode[]

    // The real rows outside the fence are still restated...
    expect(rowsOf(['- a', '  - b'].join('\n')).map((row) => row.depth)).toEqual([0, 1])

    const code = nodes.find((node) => node.type === 'code')
    expect(code).toBeDefined()
    const codeText = (code?.children ?? [])
      .filter((child) => child.type === 'text')
      .map((child) => child.text ?? '')
      .join('')
    // ...and the fenced sample keeps its own two spaces: it is text, not
    // structure. Asserted as EXACT bytes, because `toContain('  - fenced
    // child')` is also satisfied by '    - fenced child' and would pass over
    // the very rewrite this test exists to forbid.
    expect(codeText).toBe('- fenced\n  - fenced child')
  })

  it('still gives every real nested row its own todo id, and no wrapper one', () => {
    let todo = 0
    const nodes = createAssistantMarkdownFragmentNodes(
      ['- [ ] top', '  - [x] nested'].join('\n'),
      () => `todo-ids-${++todo}`,
    ) as FragmentNode[]

    const ids: unknown[] = []
    const collect = (node: FragmentNode): void => {
      const record = node as FragmentNode & { $?: Record<string, unknown> }
      if (record.$ && 'srnChecklistTodoId' in record.$) {
        ids.push(record.$.srnChecklistTodoId)
      }
      for (const child of node.children ?? []) {
        collect(child)
      }
    }
    for (const node of nodes) {
      collect(node)
    }
    // Two rows, two ids. A third would mean the nesting wrapper was treated as a
    // task, which is what gives a checklist a phantom row.
    expect(ids).toEqual(['todo-ids-1', 'todo-ids-2'])
  })
})
