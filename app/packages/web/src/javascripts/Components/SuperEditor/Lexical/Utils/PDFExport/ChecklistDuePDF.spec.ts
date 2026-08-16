/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- browser globals must exist before loading the app's CommonJS test graph */

import path from 'path'
import vm from 'vm'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { build } from 'esbuild'
import type { ListItemNode as ListItemNodeType, ListNode as ListNodeType } from '@lexical/list'
import type { LexicalEditor } from 'lexical'
import type { PDFDataNode } from './PDFRendererCore'
import type { PDFWorkerInterface } from './PDFWorker.worker'

jest.mock('@react-pdf/renderer', () => ({
  Font: { register: jest.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
}))
jest.mock('./PDFWorker.worker', () => ({ __esModule: true, default: class PDFWorker {} }))
jest.mock('comlink', () => ({ wrap: jest.fn(() => ({ renderPDF: jest.fn() })) }))
jest.mock('unicode-script', () => ({ unicodeScripts: () => [] }))

Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis })
Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })

const { $createListItemNode, $createListNode, ListItemNode, ListNode } =
  require('@lexical/list') as typeof import('@lexical/list')
const { $createTextNode, $getRoot, createEditor } = require('lexical') as typeof import('lexical')
const { $setChecklistDueAt, $setChecklistRecurrence } =
  require('../../Nodes/ChecklistItemNode') as typeof import('../../Nodes/ChecklistItemNode')
const { createChecklistRecurrence } =
  require('../../../Checklist/checklistRecurrence') as typeof import('../../../Checklist/checklistRecurrence')
const { $generatePDFFromNodes, getPDFDataNodeFromLexicalNode } = require('./PDFExport') as typeof import('./PDFExport')

const EXPORT_NOW = Date.parse('2099-08-12T11:00:00.000Z')
const DUE_AT = '2099-08-12T12:00:00.000Z'

const childNodes = (node: PDFDataNode): PDFDataNode[] => (node && Array.isArray(node.children) ? node.children : [])

const projectedText = (node: PDFDataNode): string => {
  if (!node) {
    return ''
  }
  if (typeof node.children === 'string') {
    return node.children
  }
  return childNodes(node).map(projectedText).join('')
}

const createNestedChecklistEditor = (): LexicalEditor => {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const parent = $createListItemNode(false).append($createTextNode('Parent task'))
      const child = $createListItemNode(false).append($createTextNode('Child task'))
      $setChecklistDueAt(parent, DUE_AT)
      $setChecklistRecurrence(parent, createChecklistRecurrence('weekly', DUE_AT, 'UTC'))
      parent.append($createListNode('check').append(child))
      $getRoot().append($createListNode('check').append(parent))
    },
    { discrete: true },
  )
  return editor
}

const createSingleChecklistEditor = (label: string, structuralWrapper: boolean): LexicalEditor => {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const item = $createListItemNode(false).append($createTextNode(label))
      const list = $createListNode('check')
      if (structuralWrapper) {
        list.append($createListItemNode().append($createListNode('check').append(item)))
      } else {
        list.append(item)
      }
      $getRoot().append(list)
    },
    { discrete: true },
  )
  return editor
}

const countCheckboxes = (node: PDFDataNode): number => {
  if (!node) {
    return 0
  }
  const style = Array.isArray(node.style) ? Object.assign({}, ...node.style) : node.style
  const own = node.type === 'View' && style && 'width' in style && style.width === 14 && style.height === 14 ? 1 : 0
  return own + childNodes(node).reduce((total, child) => total + countCheckboxes(child), 0)
}

const blobBytes = (blob: Blob): Promise<Uint8Array> => blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))

type ExtractedTextItem = { str: string; transform: number[] }
type ExtractedPDF = { pages: number; items: ExtractedTextItem[] }

const pdfJsPackagePath = require.resolve('pdfjs-dist/package.json')
const standardFontDataUrl = `${path.dirname(pdfJsPackagePath).replace(/\\/g, '/')}/standard_fonts/`

const PDFJS_EXTRACT_SCRIPT = `
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { pdfBase64, standardFontDataUrl } = JSON.parse(input)
const loadingTask = getDocument({
  data: Uint8Array.from(Buffer.from(pdfBase64, 'base64')),
  standardFontDataUrl,
  useWorkerFetch: false,
})
try {
  const document = await loadingTask.promise
  const page = await document.getPage(1)
  try {
    const content = await page.getTextContent()
    const items = content.items
      .filter((item) => 'str' in item)
      .map(({ str, transform }) => ({ str, transform }))
    process.stdout.write(JSON.stringify({ pages: document.numPages, items }))
  } finally {
    page.cleanup()
  }
} finally {
  await loadingTask.destroy()
}
`

const extractPDFText = (bytes: Uint8Array): Promise<ExtractedPDF> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', PDFJS_EXTRACT_SCRIPT], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PDF.js extraction failed (${code ?? 'unknown'}): ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as ExtractedPDF)
      } catch (error) {
        reject(new Error(`PDF.js returned invalid extraction JSON: ${String(error)}; stderr: ${stderr.trim()}`))
      }
    })
    child.stdin.end(
      JSON.stringify({
        pdfBase64: Buffer.from(bytes).toString('base64'),
        standardFontDataUrl,
      }),
    )
  })

type ArtifactRenderer = PDFWorkerInterface['renderPDF']

let artifactRendererPromise: Promise<ArtifactRenderer> | undefined

const loadArtifactRenderer = (): Promise<ArtifactRenderer> => {
  artifactRendererPromise ??= build({
    stdin: {
      contents:
        "import * as runtime from '@react-pdf/renderer'; import { renderPDFWithRuntime } from './PDFRendererCore.ts'; export const render = (...args) => renderPDFWithRuntime(runtime, ...args);",
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  }).then(({ outputFiles }) => {
    const filename = path.join(__dirname, 'ChecklistDuePDF.artifact-runtime.cjs')
    const artifactModule: { exports: { render?: ArtifactRenderer } } = { exports: {} }
    const wrapper = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) { ${outputFiles[0].text}\n})`,
      { filename },
    ) as (
      exports: typeof artifactModule.exports,
      require: NodeRequire,
      module: typeof artifactModule,
      filename: string,
      dirname: string,
    ) => void
    wrapper(artifactModule.exports, createRequire(filename), artifactModule, filename, __dirname)
    if (!artifactModule.exports.render) {
      throw new Error('Could not load real PDF artifact renderer')
    }
    return artifactModule.exports.render
  })
  return artifactRendererPromise
}

describe('checklist due date PDF projection', () => {
  it('projects a normal checkbox row with label and due text, then indents its nested list below', () => {
    const editor = createNestedChecklistEditor()

    const projected = editor.getEditorState().read(() => {
      const list = $getRoot().getFirstChildOrThrow<ListNodeType>()
      const parent = list.getFirstChildOrThrow<ListItemNodeType>()
      return getPDFDataNodeFromLexicalNode(parent, [], false, EXPORT_NOW)
    })

    expect(projected?.type).toBe('View')
    const [parentRow, nestedWrapper] = childNodes(projected)
    expect(parentRow?.type).toBe('View')
    const [checkbox, parentLabel] = childNodes(parentRow)
    expect(checkbox?.type).toBe('View')
    expect(checkbox?.style).toEqual(expect.objectContaining({ width: 14, height: 14 }))
    expect(parentLabel?.type).toBe('Text')
    expect(projectedText(parentLabel)).toContain('Parent task')
    expect(projectedText(parentLabel)).toContain('Due ')
    expect(projectedText(parentLabel)).toContain(`[${DUE_AT}]`)
    expect(projectedText(parentLabel)).toContain('(1h left)')
    expect(projectedText(parentLabel)).toContain('Repeats weekly')
    expect(projectedText(parentLabel)).toContain('UTC wall time')
    expect(projectedText(parentLabel)).not.toContain('Child task')

    expect(nestedWrapper?.type).toBe('View')
    expect(nestedWrapper?.style).toEqual(expect.objectContaining({ marginLeft: 20 }))
    expect(projectedText(nestedWrapper)).toContain('Child task')
  })

  it('projects a wrapper-only listitem as indentation without a phantom checkbox row', () => {
    const editor = createSingleChecklistEditor('Nested task', true)

    const projected = editor.getEditorState().read(() => {
      const list = $getRoot().getFirstChildOrThrow<ListNodeType>()
      const wrapper = list.getFirstChildOrThrow<ListItemNodeType>()
      return getPDFDataNodeFromLexicalNode(wrapper, [], false, EXPORT_NOW)
    })

    expect(projected?.type).toBe('View')
    expect(projectedText(projected)).toBe('Nested task')
    expect(childNodes(projected)).toHaveLength(1)
    expect(childNodes(projected)[0]?.type).toBe('View')
    expect(projected?.style).toEqual(expect.arrayContaining([expect.objectContaining({ marginLeft: 20 })]))
    expect(countCheckboxes(projected)).toBe(1)
  })

  it('renders a real PDF Blob whose extracted text keeps the parent and due inline above the child', async () => {
    const editor = createNestedChecklistEditor()
    const artifactRenderer = await loadArtifactRenderer()

    const blob = await $generatePDFFromNodes(editor, 'A4', undefined, EXPORT_NOW, artifactRenderer)
    const bytes = await blobBytes(blob)

    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(100)
    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-')

    expect(standardFontDataUrl).toMatch(/\/standard_fonts\/$/)
    expect(standardFontDataUrl).not.toContain('\\')
    const extracted = await extractPDFText(bytes)
    expect(extracted.pages).toBe(1)
    const { items } = extracted
    const allText = items.map(({ str }) => str).join(' ')
    expect(allText).toContain('Parent task')
    expect(allText).toContain('Due ')
    expect(allText).toContain(`[${DUE_AT}]`)
    expect(allText).toContain('(1h left)')
    expect(allText).toContain('Repeats weekly')
    expect(allText).toContain('UTC wall time')
    expect(allText).toContain('Child task')

    const parent = items.find(({ str }) => str.includes('Parent task'))
    const due = items.find(({ str }) => str.includes('Due ')) ?? parent
    const child = items.find(({ str }) => str.includes('Child task'))
    expect(parent).toBeDefined()
    expect(due).toBeDefined()
    expect(child).toBeDefined()
    expect(due?.transform[5]).toBeCloseTo(parent?.transform[5] ?? Number.NaN, 1)
    expect(parent?.transform[5]).toBeGreaterThan(child?.transform[5] ?? Number.POSITIVE_INFINITY)
  })

  it('renders wrapper-only nesting at the top baseline with horizontal indentation and no blank row', async () => {
    const artifactRenderer = await loadArtifactRenderer()
    const nestedBlob = await $generatePDFFromNodes(
      createSingleChecklistEditor('Nested task', true),
      'A4',
      undefined,
      EXPORT_NOW,
      artifactRenderer,
    )
    const topLevelBlob = await $generatePDFFromNodes(
      createSingleChecklistEditor('Top task', false),
      'A4',
      undefined,
      EXPORT_NOW,
      artifactRenderer,
    )

    const [nestedPDF, topLevelPDF] = await Promise.all([
      extractPDFText(await blobBytes(nestedBlob)),
      extractPDFText(await blobBytes(topLevelBlob)),
    ])
    expect(nestedPDF.pages).toBe(1)
    expect(topLevelPDF.pages).toBe(1)
    const nested = nestedPDF.items.find(({ str }) => str.includes('Nested task'))
    const topLevel = topLevelPDF.items.find(({ str }) => str.includes('Top task'))
    expect(nested).toBeDefined()
    expect(topLevel).toBeDefined()
    expect(nested?.transform[4]).toBeGreaterThan(topLevel?.transform[4] ?? Number.POSITIVE_INFINITY)
    expect(nested?.transform[5]).toBeCloseTo(topLevel?.transform[5] ?? Number.NaN, 1)
  })
})
