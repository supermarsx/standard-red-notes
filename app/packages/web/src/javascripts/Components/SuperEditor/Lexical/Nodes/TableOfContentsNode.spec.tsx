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
  expect((entries()[0].parentElement as HTMLElement).style.paddingLeft).toBe('0rem')
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
