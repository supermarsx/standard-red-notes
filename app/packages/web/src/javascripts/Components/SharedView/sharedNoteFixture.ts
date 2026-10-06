import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createListItemNode, $createListNode } from '@lexical/list'
import { $createLinkNode } from '@lexical/link'
import { $createCodeNode } from '@lexical/code'
import { $createTableCellNode, $createTableNode, $createTableRowNode, TableCellHeaderStates } from '@lexical/table'
import { $createHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'

import BlocksEditorTheme from '../SuperEditor/Lexical/Theme/Theme'
import { BlockEditorNodes } from '../SuperEditor/Lexical/Nodes/AllNodes'
import { $createMermaidNode } from '../SuperEditor/Lexical/Nodes/MermaidNode'
import { $createGanttChartNode } from '../SuperEditor/Lexical/Nodes/GanttChartNode'
import { $createCalloutNode } from '../SuperEditor/Lexical/Nodes/CalloutNode'
import { $createMathNode } from '../SuperEditor/Lexical/Nodes/MathNode'
import { $createCollapsibleContainerNode } from '../SuperEditor/Plugins/CollapsiblePlugin/CollapsibleContainerNode'
import { $createCollapsibleContentNode } from '../SuperEditor/Plugins/CollapsiblePlugin/CollapsibleContentNode'
import { $createCollapsibleTitleNode } from '../SuperEditor/Plugins/CollapsiblePlugin/CollapsibleTitleNode'
import { $createFileNode } from '../SuperEditor/Plugins/EncryptedFilePlugin/Nodes/FileUtils'
import { $createRemoteImageNode } from '../SuperEditor/Plugins/RemoteImagePlugin/RemoteImageNode'
import { SharedImageNode } from '../SuperEditor/Lexical/Nodes/SharedImageNode'
import { $createYouTubeNode } from '../SuperEditor/Lexical/Nodes/YouTubeNode'

/**
 * One Super note holding every construct the shared viewer has to draw, built
 * with the REAL node registry and the REAL `$create*` helpers so the serialized
 * JSON is exactly what the editor would have saved.
 *
 * It is a module rather than a literal on purpose: a hand-written fixture
 * drifts from the node it claims to represent, and a renderer test built on a
 * drifted fixture proves nothing about the note a reader actually opens.
 *
 * The markers are upper-case single words so a DOM assertion can tell "the
 * table rendered" from "the word table appears somewhere".
 */
export const SHARE_FIXTURE_MARKERS = {
  heading: 'SHAREFIXTUREHEADING',
  subheading: 'SECONDLEVEL',
  bold: 'BOLDWORD',
  italic: 'ITALICWORD',
  inlineCode: 'INLINECODE',
  link: 'LINKTEXT',
  bulletOne: 'BULLETONE',
  numberOne: 'NUMBERONE',
  checkDone: 'CHECKDONE',
  checkTodo: 'CHECKTODO',
  quote: 'QUOTEDTEXT',
  codeBlock: 'CODEBLOCKMARKER',
  tableHeader: 'TABLEHEADA',
  tableCell: 'TABLECELLA',
  collapsibleTitle: 'COLLAPSIBLETITLE',
  collapsibleBody: 'COLLAPSIBLEBODY',
  callout: 'CALLOUTBODY',
  omittedImage: 'OMITTEDIMAGENAME',
  redactedEmbed: 'YouTube video',
  mermaidNode: 'MERMAIDSTART',
  trailing: 'TRAILINGPARAGRAPH',
} as const

/** A 1x1 transparent GIF, as a `data:` URL. Real bytes, smallest possible. */
export const SHARE_FIXTURE_INLINE_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** The id a YouTube embed would hand to youtube-nocookie.com on mount. */
export const SHARE_FIXTURE_YOUTUBE_ID = 'SHAREBEACONVIDEOID'

export const SHARE_FIXTURE_MERMAID_SOURCE =
  'graph TD\n  MERMAIDA[MERMAIDSTART] --> MERMAIDB{MERMAIDDECISION}\n  MERMAIDB -->|Yes| MERMAIDC[MERMAIDOK]'

export function buildSharedSuperFixture(): string {
  const editor = createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => {
      throw error
    },
    nodes: BlockEditorNodes,
  })

  const paragraph = (text: string) => {
    const node = $createParagraphNode()
    node.append($createTextNode(text))
    return node
  }

  editor.update(
    () => {
      const root = $getRoot()
      root.clear()

      const heading = $createHeadingNode('h1')
      heading.append($createTextNode(SHARE_FIXTURE_MARKERS.heading))
      root.append(heading)

      const subheading = $createHeadingNode('h2')
      subheading.append($createTextNode(SHARE_FIXTURE_MARKERS.subheading))
      root.append(subheading)

      const formats = $createParagraphNode()
      formats.append($createTextNode('plain '))
      const bold = $createTextNode(SHARE_FIXTURE_MARKERS.bold)
      bold.toggleFormat('bold')
      formats.append(bold)
      formats.append($createTextNode(' '))
      const italic = $createTextNode(SHARE_FIXTURE_MARKERS.italic)
      italic.toggleFormat('italic')
      formats.append(italic)
      formats.append($createTextNode(' '))
      const inlineCode = $createTextNode(SHARE_FIXTURE_MARKERS.inlineCode)
      inlineCode.toggleFormat('code')
      formats.append(inlineCode)
      root.append(formats)

      const linkParagraph = $createParagraphNode()
      const link = $createLinkNode('https://example.invalid/share-target')
      link.append($createTextNode(SHARE_FIXTURE_MARKERS.link))
      linkParagraph.append(link)
      root.append(linkParagraph)

      const bullets = $createListNode('bullet')
      for (const text of [SHARE_FIXTURE_MARKERS.bulletOne, 'BULLETTWO']) {
        const item = $createListItemNode()
        item.append($createTextNode(text))
        bullets.append(item)
      }
      root.append(bullets)

      const numbers = $createListNode('number')
      for (const text of [SHARE_FIXTURE_MARKERS.numberOne, 'NUMBERTWO']) {
        const item = $createListItemNode()
        item.append($createTextNode(text))
        numbers.append(item)
      }
      root.append(numbers)

      const checklist = $createListNode('check')
      const done = $createListItemNode(true)
      done.append($createTextNode(SHARE_FIXTURE_MARKERS.checkDone))
      checklist.append(done)
      const todo = $createListItemNode(false)
      todo.append($createTextNode(SHARE_FIXTURE_MARKERS.checkTodo))
      checklist.append(todo)
      root.append(checklist)

      const quote = $createQuoteNode()
      quote.append($createTextNode(SHARE_FIXTURE_MARKERS.quote))
      root.append(quote)

      const code = $createCodeNode('javascript')
      code.append($createTextNode(`const ${SHARE_FIXTURE_MARKERS.codeBlock} = 1`))
      root.append(code)

      root.append($createHorizontalRuleNode())

      const table = $createTableNode()
      const headerRow = $createTableRowNode()
      for (const text of [SHARE_FIXTURE_MARKERS.tableHeader, 'TABLEHEADB']) {
        const cell = $createTableCellNode(TableCellHeaderStates.ROW)
        cell.append(paragraph(text))
        headerRow.append(cell)
      }
      table.append(headerRow)
      const bodyRow = $createTableRowNode()
      for (const text of [SHARE_FIXTURE_MARKERS.tableCell, 'TABLECELLB']) {
        const cell = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
        cell.append(paragraph(text))
        bodyRow.append(cell)
      }
      table.append(bodyRow)
      root.append(table)

      const collapsible = $createCollapsibleContainerNode(true)
      const title = $createCollapsibleTitleNode()
      title.append($createTextNode(SHARE_FIXTURE_MARKERS.collapsibleTitle))
      const content = $createCollapsibleContentNode()
      content.append(paragraph(SHARE_FIXTURE_MARKERS.collapsibleBody))
      collapsible.append(title, content)
      root.append(collapsible)

      root.append($createCalloutNode({ variant: 'info', text: SHARE_FIXTURE_MARKERS.callout }))
      root.append($createMathNode('E = mc^2'))
      root.append($createMermaidNode(SHARE_FIXTURE_MERMAID_SOURCE))
      root.append($createGanttChartNode())
      // The two shapes a shared image arrives in (c5d4b6d2): the inlined
      // `data:` URL, and the VISIBLE placeholder for one that could not come.
      // A 1x1 transparent GIF is the smallest real image bytes that pass the
      // node's own source gate.
      root.append(
        new SharedImageNode({
          src: SHARE_FIXTURE_INLINE_GIF,
          mimeType: 'image/gif',
          fileName: 'INLINEDIMAGE.gif',
          caption: 'SHAREDIMAGECAPTION',
        }),
      )
      root.append(
        new SharedImageNode({
          reason: 'too-large',
          fileName: 'OMITTEDIMAGENAME.png',
          message: '[OMITTEDIMAGENAME.png is too large to embed in a share link.]',
        }),
      )

      root.append($createRemoteImageNode('https://example.invalid/remote-image.png', 'REMOTEIMAGEALT'))
      root.append($createFileNode('00000000-0000-4000-8000-00000000f11e'))

      // A node that renders a third-party iframe the instant it mounts. On a
      // public page that is a beacon, so `SharedNodePolicy` must have removed
      // it before Lexical ever parsed this state.
      root.append($createYouTubeNode(SHARE_FIXTURE_YOUTUBE_ID))
      root.append(paragraph(SHARE_FIXTURE_MARKERS.trailing))
    },
    { discrete: true },
  )

  return JSON.stringify(editor.getEditorState().toJSON())
}
