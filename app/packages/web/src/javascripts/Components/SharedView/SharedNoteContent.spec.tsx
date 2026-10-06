/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'

import SharedNoteContent from './SharedNoteContent'

/**
 * The non-Super half of the gap list. Before this component existed every one
 * of these went through `markdownToHtml`, which is correct for exactly one of
 * them.
 *
 * Measured in headless Chrome against a share link per note type:
 *   plain-text   `# HEADING` became an <h1> and `**BOLD**` became <strong>
 *   rich-text    the markup was ESCAPED, so `<h1>Title</h1>` was on screen as
 *                visible text
 *   code         markdown-reflowed into a paragraph, monospace lost
 *   markdown     correct
 *
 * Each case below asserts the DOM, not that the component mounted.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLAIN_SOURCE = '# NOT A HEADING\n\nplain **NOT BOLD** text\n    indented line'

describe('SharedNoteContent', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (element: React.JSX.Element) => {
    await act(async () => {
      root.render(element)
      await Promise.resolve()
    })
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

  describe('a plaintext note', () => {
    beforeEach(async () => {
      await render(<SharedNoteContent text={PLAIN_SOURCE} noteType="plain-text" />)
    })

    it('is rendered verbatim, not interpreted as markdown', () => {
      const block = container.querySelector('[data-shared-note-format="plain"]')
      expect(block).not.toBeNull()
      expect(block?.textContent).toContain('# NOT A HEADING')
      expect(block?.textContent).toContain('**NOT BOLD**')
    })

    it('invents no structure the author did not write', () => {
      expect(container.querySelector('h1')).toBeNull()
      expect(container.querySelector('strong')).toBeNull()
    })

    it('keeps the indentation', () => {
      expect(container.querySelector('pre')?.textContent).toContain('    indented line')
    })
  })

  describe('a markdown note', () => {
    it('is still rendered as markdown', async () => {
      await render(<SharedNoteContent text={'# A HEADING\n\n- ITEM'} noteType="markdown" />)
      expect(container.querySelector('[data-shared-note-format="markdown"]')).not.toBeNull()
      expect(container.querySelector('h1')?.textContent).toContain('A HEADING')
      expect(container.querySelector('li')?.textContent).toContain('ITEM')
    })

    it('is what an envelope with no declared note type falls back to', async () => {
      await render(<SharedNoteContent text={'# A HEADING'} />)
      expect(container.querySelector('h1')?.textContent).toContain('A HEADING')
    })
  })

  describe('a legacy rich-text note', () => {
    it('renders its markup instead of printing it', async () => {
      await render(<SharedNoteContent text={'<h1>REAL HEADING</h1><ul><li>REAL ITEM</li></ul>'} noteType="rich-text" />)
      expect(container.querySelector('[data-shared-note-format="html"]')).not.toBeNull()
      expect(container.querySelector('h1')?.textContent).toBe('REAL HEADING')
      expect(container.querySelector('li')?.textContent).toBe('REAL ITEM')
      expect(container.textContent).not.toContain('<h1>')
    })

    it('neutralizes a script smuggled into the note', async () => {
      // This path is a NEW sink: the markdown renderer escapes `<` before the
      // sanitizer ever sees it, so until now no author-written markup reached
      // the DOM of this page. The page is same-origin with the signed-in app.
      await render(
        <SharedNoteContent
          text={'<p>BEFORE</p><script>window.__shareXss = true</script><img src=x onerror="window.__shareXss = true">'}
          noteType="rich-text"
        />,
      )
      expect(container.textContent).toContain('BEFORE')
      expect(container.querySelectorAll('script')).toHaveLength(0)
      const withHandlers = Array.from(container.querySelectorAll('*')).filter((element) =>
        Array.from(element.attributes).some((attribute) => attribute.name.toLowerCase().startsWith('on')),
      )
      expect(withHandlers).toHaveLength(0)
      expect((globalThis as { __shareXss?: boolean }).__shareXss).toBeUndefined()
    })

    it('neutralizes a javascript: link', async () => {
      await render(<SharedNoteContent text={'<a href="javascript:alert(1)">GO</a>'} noteType="rich-text" />)
      const href = container.querySelector('a')?.getAttribute('href') ?? ''
      expect(href.replace(/\s+/g, '').toLowerCase().startsWith('javascript:')).toBe(false)
    })
  })

  describe('a code note', () => {
    it('is rendered verbatim in a preformatted block', async () => {
      const source = 'function f() {\n    return 1\n}'
      await render(<SharedNoteContent text={source} noteType="code" />)
      const block = container.querySelector('[data-shared-note-format="code"]')
      expect(block?.tagName).toBe('PRE')
      expect(block?.textContent).toBe(source)
    })
  })

  describe('a Super note', () => {
    it('is routed to the Super renderer from its own bytes, with no declared type', async () => {
      const superText = JSON.stringify({
        root: {
          children: [
            {
              children: [
                { detail: 0, format: 0, mode: 'normal', style: '', text: 'SUPERPARAGRAPH', type: 'text', version: 1 },
              ],
              direction: null,
              format: '',
              indent: 0,
              type: 'paragraph',
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1,
        },
      })

      await render(<SharedNoteContent text={superText} />)
      // The Super body is a lazy chunk; give the import a turn to resolve.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(container.querySelector('[data-shared-note-format="super"]')).not.toBeNull()
      expect(container.textContent).toContain('SUPERPARAGRAPH')
      // And never the raw state, which is the whole defect.
      expect(container.textContent).not.toContain('"type":"paragraph"')
    })
  })
})
