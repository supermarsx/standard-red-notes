import {
  assertSuperNoteMarkdownRewriteSafe,
  UnsafeSuperNoteMarkdownRewriteError,
  validateSuperNoteMarkdownRewrite,
} from './superNoteMarkdownRewriteGuard'

const elementDefaults = {
  direction: null,
  format: '',
  indent: 0,
  version: 1,
}

const text = (value: string, format = 0) => ({
  detail: 0,
  format,
  mode: 'normal',
  style: '',
  text: value,
  type: 'text',
  version: 1,
})

const paragraph = (children: unknown[]) => ({
  ...elementDefaults,
  children,
  style: '',
  textFormat: 0,
  textStyle: '',
  type: 'paragraph-styled',
})

describe('Super note Markdown rewrite guard', () => {
  it('accepts the conservative portable rich-text subset', () => {
    const document = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [
          {
            ...elementDefaults,
            type: 'heading-styled',
            tag: 'h2',
            style: '',
            children: [text('Portable note')],
          },
          paragraph([
            text('A bold introduction with ', 1),
            {
              ...elementDefaults,
              type: 'link',
              url: 'https://example.com/docs',
              rel: null,
              target: null,
              title: null,
              children: [text('a link')],
            },
            text(' and an image: '),
            {
              type: 'unencrypted-image',
              version: 1,
              format: '',
              src: 'https://example.com/diagram.png',
              alt: 'Diagram',
              float: 'none',
            },
          ]),
          {
            ...elementDefaults,
            type: 'list',
            listType: 'bullet',
            start: 1,
            tag: 'ul',
            children: [
              {
                ...elementDefaults,
                type: 'listitem',
                value: 1,
                children: [text('First item')],
              },
            ],
          },
          {
            ...elementDefaults,
            type: 'table',
            children: [
              {
                ...elementDefaults,
                type: 'tablerow',
                children: [
                  {
                    ...elementDefaults,
                    type: 'tablecell',
                    colSpan: 1,
                    rowSpan: 1,
                    headerState: 0,
                    backgroundColor: null,
                    children: [paragraph([text('Column')])],
                  },
                ],
              },
              {
                ...elementDefaults,
                type: 'tablerow',
                children: [
                  {
                    ...elementDefaults,
                    type: 'tablecell',
                    colSpan: 1,
                    rowSpan: 1,
                    headerState: 0,
                    backgroundColor: null,
                    children: [paragraph([text('Value')])],
                  },
                ],
              },
            ],
          },
          {
            ...elementDefaults,
            type: 'code',
            language: 'typescript',
            theme: null,
            children: [text('const ready = true')],
          },
          {
            type: 'mermaid',
            version: 2,
            code: 'graph TD\n  A --> B',
            theme: 'default',
            viewMode: 'split',
          },
        ],
      },
    })

    expect(validateSuperNoteMarkdownRewrite(document)).toEqual({ ok: true })
    expect(() => assertSuperNoteMarkdownRewriteSafe(document)).not.toThrow()
  })

  it('rejects a scheduled recurring checklist before any rewrite can discard its metadata', () => {
    const document = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [
          {
            ...elementDefaults,
            type: 'list',
            listType: 'check',
            start: 1,
            tag: 'ul',
            children: [
              {
                ...elementDefaults,
                type: 'listitem',
                checked: false,
                value: 1,
                $: {
                  srnChecklistTodoId: 'todo-release-123',
                  srnChecklistSchedule: {
                    version: 1,
                    dueAt: '2026-08-20T09:00:00.000Z',
                    recurrence: { frequency: 'weekly', interval: 1 },
                  },
                },
                children: [text('Ship release')],
              },
            ],
          },
        ],
      },
    })

    const result = validateSuperNoteMarkdownRewrite(document)
    expect(result).toMatchObject({
      ok: false,
      code: 'checklist-not-portable',
      path: 'root.children[0].listType',
    })
    expect(result.ok ? '' : result.reason).toMatch(/identities.*due dates.*recurrence/i)
    expect(() => assertSuperNoteMarkdownRewriteSafe(document)).toThrow(UnsafeSuperNoteMarkdownRewriteError)
  })

  it('rejects non-empty NodeState even on an otherwise ordinary paragraph', () => {
    const document = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [{ ...paragraph([text('Stateful')]), $: { futureMetadata: { keep: true } } }],
      },
    })

    expect(validateSuperNoteMarkdownRewrite(document)).toMatchObject({
      ok: false,
      code: 'node-state-not-portable',
      path: 'root.children[0].$',
    })
  })

  it('rejects unsupported embeds and lossy structured presentation fields with a clear path', () => {
    const customEmbed = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [{ type: 'calendar', version: 1, events: [] }],
      },
    })
    expect(validateSuperNoteMarkdownRewrite(customEmbed)).toMatchObject({
      ok: false,
      code: 'unsupported-node',
      path: 'root.children[0]',
    })

    const sizedImage = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [
          paragraph([
            { type: 'unencrypted-image', version: 1, format: '', src: 'https://example.com/a.png', width: 480 },
          ]),
        ],
      },
    })
    expect(validateSuperNoteMarkdownRewrite(sizedImage)).toMatchObject({
      ok: false,
      code: 'property-not-portable',
      path: 'root.children[0].children[0].width',
    })

    const columnHeaderTable = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [
          {
            ...elementDefaults,
            type: 'table',
            children: [
              {
                ...elementDefaults,
                type: 'tablerow',
                children: [
                  {
                    ...elementDefaults,
                    type: 'tablecell',
                    colSpan: 1,
                    rowSpan: 1,
                    headerState: 2,
                    backgroundColor: null,
                    children: [paragraph([text('Column header')])],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    expect(validateSuperNoteMarkdownRewrite(columnHeaderTable)).toMatchObject({
      ok: false,
      code: 'property-not-portable',
      path: 'root.children[0].children[0].children[0]',
    })

    const previewOnlyMermaid = JSON.stringify({
      root: {
        ...elementDefaults,
        type: 'root',
        children: [{ type: 'mermaid', version: 2, code: 'graph TD\n  A --> B', theme: 'default', viewMode: 'preview' }],
      },
    })
    expect(validateSuperNoteMarkdownRewrite(previewOnlyMermaid)).toMatchObject({
      ok: false,
      code: 'property-not-portable',
      path: 'root.children[0].viewMode',
    })
  })
})
