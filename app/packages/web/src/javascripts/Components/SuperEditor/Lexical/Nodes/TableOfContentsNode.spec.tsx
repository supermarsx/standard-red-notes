/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { $createHeadingNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createTextNode, $getNodeByKey, $getRoot, LexicalEditor, NodeKey } from 'lexical'
import { STYLED_BLOCK_NODE_OVERRIDES } from './StyledBlockNodes'
import { $createTableOfContentsNode, TableOfContentsNode } from './TableOfContentsNode'
import { sanitizePrintBody } from '@/Components/NoteView/Print/PrintNote'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: LexicalEditor
let trailingKey: NodeKey
let container: HTMLElement
let root: Root

function CaptureEditor() {
  const [current] = useLexicalComposerContext()
  useEffect(() => {
    editor = current
  }, [current])
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function mount(onlyBlank = false) {
  await act(async () =>
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: 'toc-empty-headings',
          nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, TableOfContentsNode],
          onError: (error) => {
            throw error
          },
          editorState: () => {
            const index = $createTableOfContentsNode()
            index.setFormat({ numbered: true })
            const trailing = $createHeadingNode('h2')
            trailingKey = trailing.getKey()
            $getRoot().append($createHeadingNode('h1'), index)
            if (!onlyBlank) {
              $getRoot().append($createHeadingNode('h2').append($createTextNode('Actual section')))
            }
            $getRoot().append($createHeadingNode('h3').append($createTextNode(' \t\u00a0 ')), trailing)
          },
        }}
      >
        <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
        <CaptureEditor />
      </LexicalComposer>,
    ),
  )
}

const entries = () => Array.from(container.querySelectorAll('[data-table-of-contents-block] button'))

it('omits blank heading blocks from the rendered index and keeps numbering contiguous', async () => {
  await mount()
  expect(entries().map((button) => button.textContent)).toEqual(['1. Actual section'])
  expect((entries()[0].parentElement as HTMLElement).style.paddingInlineStart).toBe('0px')
  expect(
    editor.getEditorState().read(() => {
      const last = $getRoot().getLastChild()
      return last instanceof HeadingNode && last.getTextContent() === ''
    }),
  ).toBe(true)
})

it('shows the empty state when every heading is blank', async () => {
  await mount(true)
  expect(entries()).toHaveLength(0)
  expect(container.querySelector('[data-table-of-contents-block]')?.textContent).toContain('No headings found')
})

it('renders custom titles, an optional subtitle and entry formatting without creating document headings', async () => {
  await mount()
  await act(async () =>
    editor.update(
      () => {
        const index = $getRoot()
          .getChildren()
          .find((node) => node instanceof TableOfContentsNode) as TableOfContentsNode
        index.setFormat({
          title: 'Research guide',
          subtitle: 'Your route through the findings',
          titleSize: 26,
          subtitleSize: 16,
          titleWeight: 'bold',
          titleItalic: true,
          uppercaseTitle: false,
          titleColor: '#123456',
          subtitleColor: '#456789',
          entrySize: 18,
          entryColor: '#789abc',
          font: 'serif',
          alignment: 'center',
          entrySpacing: 8,
          appearance: 'plain',
          wrapEntries: true,
        })
      },
      { discrete: true },
    ),
  )
  const title = container.querySelector<HTMLElement>('[data-toc-title]')!
  const subtitle = container.querySelector<HTMLElement>('[data-toc-subtitle]')!
  expect(title.textContent).toBe('Research guide')
  expect(title.style.fontSize).toBe('26px')
  expect(title.style.fontWeight).toBe('700')
  expect(title.style.fontStyle).toBe('italic')
  expect(title.style.textTransform).toBe('none')
  expect(subtitle.textContent).toBe('Your route through the findings')
  expect(subtitle.style.fontSize).toBe('16px')
  const list = container.querySelector<HTMLElement>('[data-table-of-contents-block] ul')!
  expect(list.style.textAlign).toBe('center')
  expect(list.style.fontSize).toBe('18px')
  expect((entries()[0].parentElement as HTMLElement).style.paddingBlock).toBe('8px')
  expect(entries()[0].classList.contains('whitespace-normal')).toBe(true)
  expect(entries().map((button) => button.textContent)).toEqual(['1. Actual section'])
  expect(container.querySelector('[data-table-of-contents-block] h1, [data-table-of-contents-block] h2')).toBeNull()
  const printed = sanitizePrintBody(container.cloneNode(true) as HTMLElement)
  expect(printed.querySelector('[data-toc-title]')?.textContent).toBe('Research guide')
  expect(printed.querySelector('[data-toc-subtitle]')?.textContent).toBe('Your route through the findings')
  expect(printed.querySelector<HTMLElement>('[data-table-of-contents-block] ul')?.style.fontSize).toBe('18px')
  expect(printed.querySelector('[data-table-of-contents-block] button')).toBeNull()
})

it('adds a heading when it gains text and removes it when the text is cleared', async () => {
  await mount()
  await act(async () =>
    editor.update(
      () => {
        const node = $getNodeByKey(trailingKey)
        if (node instanceof HeadingNode) {
          node.append($createTextNode('New section'))
        }
      },
      { discrete: true },
    ),
  )
  expect(entries().map((button) => button.textContent)).toEqual(['1. Actual section', '2. New section'])
  await act(async () =>
    editor.update(
      () => {
        const node = $getNodeByKey(trailingKey)
        if (node instanceof HeadingNode) {
          node.clear()
        }
      },
      { discrete: true },
    ),
  )
  expect(entries().map((button) => button.textContent)).toEqual(['1. Actual section'])
})

it('renders safely when an older collaborator syncs the original format fields', async () => {
  await mount()
  await act(async () =>
    editor.update(
      () => {
        const index = $getRoot()
          .getChildren()
          .find((node) => node instanceof TableOfContentsNode) as TableOfContentsNode
        // Yjs writes node properties directly, rather than calling importJSON.
        index.getWritable().__format = { maxLevel: 3, numbered: false, showTitle: true } as ReturnType<
          TableOfContentsNode['getFormat']
        >
      },
      { discrete: true },
    ),
  )
  expect(container.querySelector('[data-toc-title]')?.textContent).toBe('Table of Contents')
  expect(container.querySelector('[data-toc-subtitle]')).toBeNull()
  expect(entries().map((button) => button.textContent)).toEqual(['Actual section'])
})
