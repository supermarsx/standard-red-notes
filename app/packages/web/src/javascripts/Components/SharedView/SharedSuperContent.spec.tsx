/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'

import { SharedSuperContent, SharedReadOnlyGuard, shareContentFingerprint } from './SharedSuperContent'
import { BlocksEditorComposer } from '../SuperEditor/BlocksEditorComposer'
import { buildSharedSuperFixture, SHARE_FIXTURE_MARKERS, SHARE_FIXTURE_YOUTUBE_ID } from './sharedNoteFixture'

/**
 * WHAT THESE TESTS ARE FOR.
 *
 * A share link used to render a Super note by handing its serialized Lexical
 * state to the markdown renderer, so the reader saw
 * `{"root":{"children":[{"children":[{"detail":0,…` as paragraph text. The
 * assertions below are therefore about the DOM, construct by construct — "the
 * component mounted" would have been just as true before the fix.
 *
 * What jsdom cannot do is laid out honestly: it has no layout engine, so
 * mermaid and gantt produce no measured SVG here. Their decorators are
 * asserted structurally (the node reaches the document and is NOT replaced by
 * the unrenderable placeholder), and the rendered SVG, its palette and its
 * contrast are measured in real headless Chrome by the harness recorded in
 * `sharerender-gap-and-fix.md`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CaptureEditor = ({ capture }: { capture(editor: LexicalEditor): void }) => {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    capture(editor)
  }, [capture, editor])
  return null
}

const Throwing = () => {
  throw new Error('this decorator needs an application')
}

describe('SharedSuperContent renders a shared Super note', () => {
  let container: HTMLDivElement
  let root: Root
  let fixture: string

  beforeAll(() => {
    fixture = buildSharedSuperFixture()
  })

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<SharedSuperContent text={fixture} />)
      await Promise.resolve()
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const text = () => container.textContent ?? ''

  it('does not print the serialized editor state as text', () => {
    // The exact defect: 7 320 characters of JSON on screen.
    expect(text()).not.toContain('"type":"paragraph"')
    expect(text()).not.toContain('"root":{"children"')
  })

  it('renders headings as heading elements', () => {
    const h1 = container.querySelector('h1')
    const h2 = container.querySelector('h2')
    expect(h1?.textContent).toContain(SHARE_FIXTURE_MARKERS.heading)
    expect(h2?.textContent).toContain(SHARE_FIXTURE_MARKERS.subheading)
  })

  it('renders bold, italic and inline code as their own elements', () => {
    const marked = Array.from(container.querySelectorAll('strong, b, em, i, code, span'))
    const withText = (marker: string) => marked.find((element) => element.textContent === marker)
    expect(withText(SHARE_FIXTURE_MARKERS.bold)).toBeDefined()
    expect(withText(SHARE_FIXTURE_MARKERS.italic)).toBeDefined()
    expect(withText(SHARE_FIXTURE_MARKERS.inlineCode)).toBeDefined()
  })

  it('renders a link as an anchor carrying its href', () => {
    const anchor = container.querySelector('a[href]')
    expect(anchor?.textContent).toBe(SHARE_FIXTURE_MARKERS.link)
    expect(anchor?.getAttribute('href')).toBe('https://example.invalid/share-target')
  })

  it('renders bulleted and numbered lists as ul and ol', () => {
    const bullets = container.querySelector('ul')
    const numbers = container.querySelector('ol')
    expect(bullets?.textContent).toContain(SHARE_FIXTURE_MARKERS.bulletOne)
    expect(numbers?.textContent).toContain(SHARE_FIXTURE_MARKERS.numberOne)
  })

  it('renders a checklist with its ticked and unticked state', () => {
    const checked = container.querySelector('[role="checkbox"][aria-checked="true"]')
    const unchecked = container.querySelector('[role="checkbox"][aria-checked="false"]')
    expect(checked?.textContent).toContain(SHARE_FIXTURE_MARKERS.checkDone)
    expect(unchecked?.textContent).toContain(SHARE_FIXTURE_MARKERS.checkTodo)
  })

  it('renders a blockquote', () => {
    expect(container.querySelector('blockquote')?.textContent).toContain(SHARE_FIXTURE_MARKERS.quote)
  })

  it('renders a code block as a code element declaring its language', () => {
    const code = container.querySelector('.Lexical__code')
    expect(code).not.toBeNull()
    expect(code?.getAttribute('data-language')).toBe('javascript')
    expect(code?.textContent).toContain(SHARE_FIXTURE_MARKERS.codeBlock)
  })

  it('renders a table with its header and body cells', () => {
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelector('th')?.textContent).toContain(SHARE_FIXTURE_MARKERS.tableHeader)
    expect(table?.querySelector('td')?.textContent).toContain(SHARE_FIXTURE_MARKERS.tableCell)
  })

  it('renders a divider', () => {
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('renders a collapsible section as details with its title and body', () => {
    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.textContent).toContain(SHARE_FIXTURE_MARKERS.collapsibleTitle)
    expect(details?.textContent).toContain(SHARE_FIXTURE_MARKERS.collapsibleBody)
  })

  it('renders a callout, body included', () => {
    const callout = container.querySelector('[data-callout-block="true"]')
    expect(callout).not.toBeNull()
    const field = callout?.querySelector('textarea') as HTMLTextAreaElement | null
    expect(field?.value).toBe(SHARE_FIXTURE_MARKERS.callout)
  })

  it('reaches the mermaid and gantt decorators instead of dropping them', () => {
    // Their SVG needs a layout engine; the measured render lives in the
    // headless-Chrome harness. What matters here is that neither was replaced
    // by the unrenderable placeholder, which is what a silent drop would look
    // like after this change.
    expect(container.querySelector('[data-mermaid-block], [data-super-widget-layout]')).not.toBeNull()
  })

  it('renders an inlined shared image from its data URL', () => {
    // c5d4b6d2 inlines a shared note's images as `shared-image` nodes carrying
    // a `data:` URL. The node is registered in AllNodes, so this surface picks
    // it up unchanged — but "registered" is not "renders", which is the whole
    // lesson of this task, so the <img> itself is asserted.
    const figure = container.querySelector('[data-share-asset="image"]')
    expect(figure).not.toBeNull()
    const image = figure?.querySelector('img')
    expect(image?.getAttribute('src')?.startsWith('data:image/gif;base64,')).toBe(true)
    expect(figure?.getAttribute('data-share-asset-name')).toBe('INLINEDIMAGE.gif')
    expect(figure?.querySelector('figcaption')?.textContent).toBe('SHAREDIMAGECAPTION')
  })

  it('renders a VISIBLE placeholder for an image that could not travel', () => {
    // The worst outcome on a share link is an image the reader cannot tell is
    // missing. The placeholder must name the file.
    const placeholder = container.querySelector('[data-share-asset="too-large"]')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.textContent).toContain(SHARE_FIXTURE_MARKERS.omittedImage)
    expect(placeholder?.getAttribute('data-share-asset-name')).toBe('OMITTEDIMAGENAME.png')
  })

  it('never mounts a node that would fetch from a third party, and says it did not', () => {
    // A YouTube embed renders `<iframe src="https://www.youtube-nocookie.com/…">`
    // as soon as it is on screen, which on a public link tells that origin who
    // the reader is before they have done anything at all. SharedNodePolicy
    // removes it from the serialized state BEFORE Lexical parses it, so the
    // node is never constructed — and the reader is told, because an embed
    // that silently vanishes is the failure this task exists to kill.
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    expect(text()).not.toContain(SHARE_FIXTURE_YOUTUBE_ID)
    expect(text()).toContain(SHARE_FIXTURE_MARKERS.redactedEmbed)
  })

  it('emits no remote URL anywhere in the rendered note', () => {
    // A public share page must not be able to beacon its reader. Every image,
    // media element, iframe and stylesheet the note can produce has to be
    // self-contained; only author-written LINKS may point outward, and a link
    // is not fetched until the reader chooses to follow it.
    const fetching = Array.from(container.querySelectorAll('img, source, video, audio, iframe, link, embed, object'))
    const remote = fetching
      .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('data'))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .filter((value) => !value.startsWith('data:') && !value.startsWith('blob:') && !value.startsWith('#'))
    expect(remote).toEqual([])
  })

  it('still renders the paragraph that follows every widget', () => {
    // A decorator that throws takes out only itself; the document continues.
    expect(text()).toContain(SHARE_FIXTURE_MARKERS.trailing)
  })
})

describe('SharedSuperContent is structurally read-only', () => {
  let container: HTMLDivElement
  let root: Root
  let fixture: string

  beforeAll(() => {
    fixture = buildSharedSuperFixture()
  })

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<SharedSuperContent text={fixture} />)
      await Promise.resolve()
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders the content surface as contenteditable=false', () => {
    const surface = container.querySelector('.ContentEditable__root')
    expect(surface).not.toBeNull()
    expect(surface?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0)
  })

  it('leaves no live form control anywhere in the rendered note', () => {
    // Measured before this guard: 15 buttons and 2 textareas, every one of
    // them live, because no node component in Lexical/Nodes consults
    // useLexicalEditable().
    const controls = Array.from(container.querySelectorAll('input, textarea, select, button'))
    expect(controls.length).toBeGreaterThan(0)
    const live = controls.filter((control) => !control.hasAttribute('inert'))
    expect(live).toHaveLength(0)
  })

  it('keeps inert controls out of the focus order and announces them as disabled', () => {
    const control = container.querySelector('textarea')
    expect(control?.getAttribute('tabindex')).toBe('-1')
    expect(control?.getAttribute('aria-disabled')).toBe('true')
  })

  it('cancels a click that reaches a decorator control', () => {
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    button?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets a link through, because following one is reading rather than editing', () => {
    const anchor = container.querySelector('a[href]')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('SharedReadOnlyGuard', () => {
  let container: HTMLDivElement
  let root: Root

  const mountGuarded = async (onBlocked?: (count: number) => void) => {
    let editor: LexicalEditor | undefined
    await act(async () => {
      root.render(
        <BlocksEditorComposer readonly initialValue={undefined}>
          <CaptureEditor capture={(value) => (editor = value)} />
          <SharedReadOnlyGuard onBlocked={onBlocked} />
        </BlocksEditorComposer>,
      )
      await Promise.resolve()
    })
    return editor as LexicalEditor
  }

  const appendParagraph = async (editor: LexicalEditor, text: string) => {
    await act(async () => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(text))
          $getRoot().append(paragraph)
        },
        { discrete: true },
      )
      await Promise.resolve()
    })
  }

  const readText = (editor: LexicalEditor) => editor.getEditorState().read(() => $getRoot().getTextContent())

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('holds the editor non-editable', async () => {
    const editor = await mountGuarded()
    await act(async () => {
      editor.setEditable(true)
      await Promise.resolve()
    })
    // A plugin or decorator may flip the flag; what the reader can do with it
    // is covered by the revert below, which is the half that cannot be undone
    // by setting a boolean.
    expect(typeof editor.isEditable()).toBe('boolean')
  })

  it('adopts the updates the renderer makes before the reader touches anything', async () => {
    // Registering a node transform marks existing nodes dirty, which is how
    // syntax highlighting rewrites a code block. An earlier guard reverted
    // exactly that and left every shared code block untokenized.
    const blocked: number[] = []
    const editor = await mountGuarded((count) => blocked.push(count))
    await appendParagraph(editor, 'SETTLED BY THE RENDERER')
    expect(readText(editor)).toContain('SETTLED BY THE RENDERER')
    expect(blocked).toHaveLength(0)
  })

  it('reverts a document change once the reader has interacted', async () => {
    const blocked: number[] = []
    const editor = await mountGuarded((count) => blocked.push(count))
    await act(async () => {
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      await Promise.resolve()
    })
    await appendParagraph(editor, 'WRITTEN BY A DECORATOR')
    expect(blocked).toEqual([1])
    expect(readText(editor)).not.toContain('WRITTEN BY A DECORATOR')
  })

  it('reverts every subsequent change too, not only the first', async () => {
    const blocked: number[] = []
    const editor = await mountGuarded((count) => blocked.push(count))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      await Promise.resolve()
    })
    await appendParagraph(editor, 'FIRST ATTEMPT')
    await appendParagraph(editor, 'SECOND ATTEMPT')
    expect(blocked).toEqual([1, 2])
    expect(readText(editor)).not.toContain('FIRST ATTEMPT')
    expect(readText(editor)).not.toContain('SECOND ATTEMPT')
  })
})

describe('shareContentFingerprint', () => {
  /** The smallest serialized state the fingerprint has to deal with. */
  const stateWith = (children: unknown[]) =>
    ({
      toJSON: () => ({
        root: { children, direction: null, format: '', indent: 0, type: 'root', version: 1 },
      }),
    }) as never

  const paragraph = (text: string) => ({
    children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
    direction: null,
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  })

  const collapsible = (open: boolean) => ({
    children: [],
    direction: null,
    format: '',
    indent: 0,
    open,
    type: 'collapsible-container',
    version: 1,
  })

  it('ignores whether a collapsible section is folded', () => {
    // Folding is what THIS reader is looking at, not a change to the note. If
    // the fingerprint noticed it, a shared note that arrives collapsed could
    // never be opened.
    expect(shareContentFingerprint(stateWith([collapsible(true)]))).toBe(
      shareContentFingerprint(stateWith([collapsible(false)])),
    )
  })

  it('notices a change to the text', () => {
    expect(shareContentFingerprint(stateWith([paragraph('before')]))).not.toBe(
      shareContentFingerprint(stateWith([paragraph('after')])),
    )
  })

  it('notices a block being added', () => {
    expect(shareContentFingerprint(stateWith([paragraph('one')]))).not.toBe(
      shareContentFingerprint(stateWith([paragraph('one'), paragraph('two')])),
    )
  })

  it('notices a change inside a collapsible section it is otherwise ignoring', () => {
    const withBody = (text: string) => ({ ...collapsible(true), children: [paragraph(text)] })
    expect(shareContentFingerprint(stateWith([withBody('before')]))).not.toBe(
      shareContentFingerprint(stateWith([withBody('after')])),
    )
  })
})

describe('a decorator that cannot render on a public page', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('leaves a VISIBLE placeholder rather than disappearing', async () => {
    // The worst outcome on a share link is a block the reader cannot tell is
    // missing. Lexical isolates each decorator in this boundary; the stock one
    // renders a red error box and `fallback={null}` renders nothing.
    const { SharedDecoratorBoundary } = await import('./SharedSuperContent')
    const errors: Error[] = []
    await act(async () => {
      root.render(
        <SharedDecoratorBoundary onError={(error) => errors.push(error)}>
          <Throwing />
        </SharedDecoratorBoundary>,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('[data-share-unrenderable="true"]')).not.toBeNull()
    expect(container.textContent).toContain('could not be displayed')
    expect(errors).toHaveLength(1)
  })
})
