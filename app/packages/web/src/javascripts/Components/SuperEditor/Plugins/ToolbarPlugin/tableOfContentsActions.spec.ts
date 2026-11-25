/** @jest-environment jsdom */
import { createHeadlessEditor } from '@lexical/headless'
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $createNodeSelection,
  $setSelection,
  UNDO_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import {
  $createTableOfContentsNode,
  TableOfContentsNode,
  normalizeTableOfContentsFormat,
} from '../../Lexical/Nodes/TableOfContentsNode'
import { STYLED_BLOCK_NODE_OVERRIDES } from '../../Lexical/Nodes/StyledBlockNodes'
import { $readTocHeadings, orderTocHeadings } from '../../Lexical/Utils/tableOfContentsOutline'
import { changeTableOfContents, moveContentsEntry, moveContentsNoteSection } from './tableOfContentsActions'

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'contents-order',
    nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, TableOfContentsNode],
    onError: (error) => {
      throw error
    },
  })
const paragraph = (text: string) => $createParagraphNode().append($createTextNode(text))
const heading = (level: 'h1' | 'h2' | 'h3', text: string) => $createHeadingNode(level).append($createTextNode(text))
function fixture() {
  const editor = makeEditor()
  let toc = '',
    secondToc = '',
    a = '',
    b = '',
    child = '',
    nested = ''
  editor.update(
    () => {
      const index = $createTableOfContentsNode()
      const other = $createTableOfContentsNode()
      const first = heading('h1', 'Alpha')
      const second = heading('h1', 'Beta')
      const sub = heading('h2', 'Alpha child')
      const deep = heading('h3', 'Nested child')
      toc = index.getKey()
      secondToc = other.getKey()
      a = first.getKey()
      b = second.getKey()
      child = sub.getKey()
      nested = deep.getKey()
      $getRoot().append(
        paragraph('Introduction'),
        index,
        other,
        first,
        paragraph('Alpha body'),
        sub,
        paragraph('Child body'),
        deep,
        paragraph('Nested body'),
        heading('h2', 'Another child'),
        paragraph('Other body'),
        second,
        paragraph('Beta body'),
      )
      const selection = $createNodeSelection()
      selection.add(toc)
      $setSelection(selection)
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
  return { editor, toc, secondToc, a, b, child, nested }
}
function contents(editor: ReturnType<typeof makeEditor>, key: string) {
  return editor
    .getEditorState()
    .read(() =>
      orderTocHeadings($readTocHeadings(), ($getNodeByKey(key) as TableOfContentsNode).getFormat().entryOrder).map(
        ({ text }) => text,
      ),
    )
}
const text = (editor: ReturnType<typeof makeEditor>) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getTextContent()),
  )

it('reorders contents branches independently without moving note content or another index', () => {
  const { editor, toc, secondToc, b } = fixture()
  const before = text(editor)
  moveContentsEntry(editor, toc, b, -1)
  expect(contents(editor, toc)).toEqual(['Beta', 'Alpha', 'Alpha child', 'Nested child', 'Another child'])
  expect(contents(editor, secondToc)).toEqual(['Alpha', 'Alpha child', 'Nested child', 'Another child', 'Beta'])
  expect(text(editor)).toEqual(before)
  changeTableOfContents(editor, toc, { entryOrder: [] })
  expect(contents(editor, toc)).toEqual(contents(editor, secondToc))
})

it('moves a child branch only among its siblings and carries its descendants', () => {
  const { editor, toc, child, nested } = fixture()
  moveContentsEntry(editor, toc, child, 1)
  expect(contents(editor, toc)).toEqual(['Alpha', 'Another child', 'Alpha child', 'Nested child', 'Beta'])
  const before = editor.getEditorState().toJSON()
  moveContentsEntry(editor, toc, nested, -1)
  expect(editor.getEditorState().toJSON()).toEqual(before)
})

it('preserves custom order across JSON reload with new node keys, duplicate names and renaming', () => {
  const { editor, toc, a, b } = fixture()
  moveContentsEntry(editor, toc, b, -1)
  editor.update(
    () => {
      ;($getNodeByKey(a) as HeadingNode).clear().append($createTextNode('Same name'))
      ;($getNodeByKey(b) as HeadingNode).clear().append($createTextNode('Same name'))
    },
    { discrete: true },
  )
  const saved = editor.getEditorState().toJSON()
  const restored = makeEditor()
  restored.setEditorState(restored.parseEditorState(saved))
  const restoredToc = restored.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .find((node) => node instanceof TableOfContentsNode)!
      .getKey(),
  )
  expect(restoredToc).not.toBe(toc)
  expect(contents(restored, restoredToc)).toEqual([
    'Same name',
    'Same name',
    'Alpha child',
    'Nested child',
    'Another child',
  ])
})

it('moves whole note sections with body blocks and nested subsections, retaining selection and node identities', () => {
  const { editor, toc, b } = fixture()
  const before = text(editor)
  const keys = editor.getEditorState().read(() => $getRoot().getChildrenKeys())
  moveContentsNoteSection(editor, toc, b, -1)
  expect(text(editor)).toEqual([...before.slice(0, 3), 'Beta', 'Beta body', ...before.slice(3, -2)])
  expect(
    editor.getEditorState().read(() =>
      $getSelection()
        ?.getNodes()
        .map((node) => node.getKey()),
    ),
  ).toEqual([toc])
  expect(new Set(editor.getEditorState().read(() => $getRoot().getChildrenKeys()))).toEqual(new Set(keys))
  moveContentsNoteSection(editor, toc, b, 1)
  expect(text(editor)).toEqual(before)
})

it('moves a physical child section without crossing its parent or detaching its nested section', () => {
  const { editor, toc, child } = fixture()
  moveContentsNoteSection(editor, toc, child, 1)
  expect(text(editor)).toEqual([
    'Introduction',
    '',
    '',
    'Alpha',
    'Alpha body',
    'Another child',
    'Other body',
    'Alpha child',
    'Child body',
    'Nested child',
    'Nested body',
    'Beta',
    'Beta body',
  ])
})

it.each(['entry', 'section'])('makes a %s move one undoable transaction', async (mode) => {
  const { editor, toc, b } = fixture()
  const history = createEmptyHistoryState()
  const stop = registerHistory(editor, history, 1000)
  // Seed the current state before the explicit history-push transaction.
  history.current = { editor, editorState: editor.getEditorState() }
  const before = editor.getEditorState().toJSON()
  ;(mode === 'entry' ? moveContentsEntry : moveContentsNoteSection)(editor, toc, b, -1)
  expect(editor.getEditorState().toJSON()).not.toEqual(before)
  editor.dispatchCommand(UNDO_COMMAND, undefined)
  await Promise.resolve()
  expect(editor.getEditorState().toJSON()).toEqual(before)
  stop()
})

it('rejects stale targets, boundaries, and all mutations in read mode', () => {
  const { editor, toc, a, b } = fixture()
  const before = editor.getEditorState().toJSON()
  moveContentsEntry(editor, toc, a, -1)
  moveContentsNoteSection(editor, toc, a, -1)
  moveContentsEntry(editor, 'deleted-index', b, -1)
  moveContentsNoteSection(editor, toc, 'deleted-heading', -1)
  editor.setEditable(false)
  moveContentsEntry(editor, toc, b, -1)
  moveContentsNoteSection(editor, toc, b, -1)
  changeTableOfContents(editor, toc, { title: 'Forbidden' })
  expect(editor.getEditorState().toJSON()).toEqual(before)
})

it('bounds and normalizes persisted entry identities from older or malformed documents', () => {
  expect(normalizeTableOfContentsFormat().entryOrder).toEqual([])
  expect(
    normalizeTableOfContentsFormat({ entryOrder: ['one', 'one', '', 'two', 'x'.repeat(129), 123] as string[] })
      .entryOrder,
  ).toEqual(['one', 'two'])
})

it('keeps embedded heading blocks with their owning section and refuses to move them individually', () => {
  const { editor, toc, b, a } = fixture()
  let embeddedKey = ''
  editor.update(
    () => {
      const embedded = heading('h1', 'Inside a quote')
      embeddedKey = embedded.getKey()
      $getNodeByKey(a)!.insertAfter($createQuoteNode().append(embedded, paragraph('Quoted body')))
    },
    { discrete: true },
  )
  const before = editor.getEditorState().toJSON()
  moveContentsNoteSection(editor, toc, embeddedKey, 1)
  expect(editor.getEditorState().toJSON()).toEqual(before)
  moveContentsNoteSection(editor, toc, b, -1)
  expect(text(editor).slice(3, 7)).toEqual(['Beta', 'Beta body', 'Alpha', 'Inside a quote\n\nQuoted body'])
})

it('repairs copied heading identities without losing entries or reusing temporary node keys', () => {
  const { editor, toc, b } = fixture()
  moveContentsEntry(editor, toc, b, -1)
  const saved = editor.getEditorState().toJSON()
  saved.root.children.push(
    JSON.parse(JSON.stringify(saved.root.children.find((node) => node.type === 'heading-styled'))),
  )
  editor.setEditorState(editor.parseEditorState(saved))
  const keys = editor.getEditorState().read(() => ({
    toc: $getRoot()
      .getChildren()
      .find((node) => node instanceof TableOfContentsNode)!
      .getKey(),
    heading: $readTocHeadings().at(-1)!.key,
  }))
  moveContentsEntry(editor, keys.toc, keys.heading, -1)
  const ids = editor.getEditorState().read(() => $readTocHeadings().map(({ id }) => id))
  expect(new Set(ids).size).toBe(ids.length)
  expect(contents(editor, keys.toc)).toHaveLength(6)
})
