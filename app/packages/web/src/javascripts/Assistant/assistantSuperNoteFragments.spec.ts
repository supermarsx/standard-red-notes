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
