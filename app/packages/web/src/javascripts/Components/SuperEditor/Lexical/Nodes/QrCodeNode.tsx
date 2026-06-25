import * as React from 'react'
import {
  ComponentType,
  Component,
  ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'

/**
 * Error-correction levels supported by the QR spec. Higher levels embed more
 * redundancy (so a partially-damaged/obscured code still scans) at the cost of
 * encoding less data per QR version.
 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H'

export const QR_ERROR_CORRECTION_LEVELS: QrErrorCorrection[] = ['L', 'M', 'Q', 'H']

/** Pixel sizes offered as quick-pick buttons. The QR scales crisply (SVG). */
export const QR_SIZE_PRESETS = [128, 192, 256] as const

export const QR_DEFAULT_SIZE = 192

export const QR_DEFAULT_ERROR_CORRECTION: QrErrorCorrection = 'M'

export const QR_VERSION = 1

export type QrCodeData = {
  version: number
  /** The URL or arbitrary string encoded into the QR code. */
  text: string
  /** Rendered pixel size of the SVG. */
  size: number
  errorCorrection: QrErrorCorrection
}

const DEFAULT_QR_CODE: QrCodeData = {
  version: QR_VERSION,
  text: '',
  size: QR_DEFAULT_SIZE,
  errorCorrection: QR_DEFAULT_ERROR_CORRECTION,
}

function isErrorCorrection(value: unknown): value is QrErrorCorrection {
  return value === 'L' || value === 'M' || value === 'Q' || value === 'H'
}

/** Clamp an incoming size to a sane range; non-numbers fall back to the default. */
function coerceSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return QR_DEFAULT_SIZE
  return Math.min(Math.max(Math.round(n), 64), 512)
}

/**
 * Normalizes data from importJSON with backward-compatible defaults. Notes
 * serialized before this widget existed (or with malformed/partial data) yield
 * an empty, editable QR block rather than throwing. Never throws.
 */
export function normalize(data: Partial<QrCodeData> | undefined | null): QrCodeData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_QR_CODE }
  }
  return {
    version: QR_VERSION,
    text: typeof data.text === 'string' ? data.text : '',
    size: coerceSize(data.size),
    errorCorrection: isErrorCorrection(data.errorCorrection)
      ? data.errorCorrection
      : QR_DEFAULT_ERROR_CORRECTION,
  }
}

function clone(data: QrCodeData): QrCodeData {
  return { ...data }
}

// Lazily-loaded SVG QR renderer so the QR library is code-split and only
// fetched when a QR block is actually rendered (mirrors Mermaid/KaTeX).
// qrcode.react bundles its own zero-network QR generator, so this works offline.
type QrCodeSvgProps = {
  value: string
  size?: number
  level?: QrErrorCorrection
  marginSize?: number
  bgColor?: string
  fgColor?: string
  title?: string
  style?: React.CSSProperties
}

const QRCodeSVG = lazyWithRetry(() =>
  import('qrcode.react').then((m) => ({
    default: m.QRCodeSVG as unknown as ComponentType<QrCodeSvgProps>,
  })),
)

/**
 * qrcode.react throws synchronously during render when the text exceeds the
 * capacity of the largest QR version (40) for the chosen error-correction
 * level. This boundary turns that crash into a friendly inline message instead
 * of taking down the editor, and resets whenever the encoded text changes.
 */
class QrRenderBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidUpdate(prevProps: { resetKey: string }): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="text-sm text-danger">
          The text is too long to fit in a QR code. Try shortening it or lowering the error correction
          level.
        </div>
      )
    }
    return this.props.children
  }
}

function QrCodeComponent({ data, nodeKey }: { data: QrCodeData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [draft, setDraft] = useState(data.text)
  const svgWrapRef = useRef<HTMLDivElement | null>(null)

  // Keep the local input in sync if the node is updated elsewhere (e.g. undo).
  useEffect(() => {
    setDraft(data.text)
  }, [data.text])

  const mutate = useCallback(
    (fn: (draft: QrCodeData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isQrCodeNode(node)) {
          const next = clone(node.getData())
          fn(next)
          node.setData(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const commitText = useCallback(
    (text: string) => {
      mutate((d) => (d.text = text))
    },
    [mutate],
  )

  const setSize = (size: number) => mutate((d) => (d.size = coerceSize(size)))
  const setErrorCorrection = (level: QrErrorCorrection) => mutate((d) => (d.errorCorrection = level))

  const trimmed = data.text.trim()

  const downloadPng = useCallback(() => {
    const svgEl = svgWrapRef.current?.querySelector('svg')
    if (!svgEl) return
    const serialized = new XMLSerializer().serializeToString(svgEl)
    const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = data.size
      canvas.height = data.size
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const link = document.createElement('a')
        link.download = 'qr-code.png'
        link.href = canvas.toDataURL('image/png')
        link.click()
      }
      URL.revokeObjectURL(url)
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url
  }, [data.size])

  return (
    <div className="my-2 rounded border border-border bg-default" data-qr-block="true">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">QR Code</span>
        <div className="flex items-center gap-1">
          {QR_SIZE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="rounded px-2 py-0.5 hover:bg-contrast aria-pressed:bg-contrast aria-pressed:text-text"
              aria-pressed={data.size === preset}
              title={`Set size to ${preset}px`}
              onClick={() => setSize(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-2 sm:flex-row sm:items-start">
        <div className="flex flex-1 flex-col gap-2">
          <textarea
            className="w-full resize-y rounded border border-border bg-default p-2 text-sm text-foreground outline-none focus:border-info"
            rows={Math.max(2, Math.min(6, draft.split('\n').length + 1))}
            value={draft}
            placeholder="Enter a URL or any text to encode…"
            aria-label="QR code content"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commitText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-passive-1">
            <label className="flex items-center gap-1">
              Error correction
              <select
                className="rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info"
                value={data.errorCorrection}
                aria-label="Error correction level"
                onChange={(e) => setErrorCorrection(e.target.value as QrErrorCorrection)}
              >
                {QR_ERROR_CORRECTION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded px-2 py-0.5 hover:bg-contrast disabled:opacity-40"
              disabled={!trimmed}
              onClick={downloadPng}
              title="Download the QR code as a PNG image"
            >
              Download PNG
            </button>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center justify-center self-center sm:self-start">
          {trimmed ? (
            <div
              ref={svgWrapRef}
              className="rounded bg-white p-2"
              style={{ width: data.size + 16, maxWidth: '100%' }}
            >
              <QrRenderBoundary resetKey={`${trimmed}|${data.errorCorrection}`}>
                <Suspense fallback={<div className="text-xs text-passive-1">Rendering…</div>}>
                  <QRCodeSVG
                    value={data.text}
                    level={data.errorCorrection}
                    size={data.size}
                    marginSize={0}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    title="QR code"
                    style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
                  />
                </Suspense>
              </QrRenderBoundary>
            </div>
          ) : (
            <div className="flex h-32 w-32 items-center justify-center rounded border border-dashed border-border text-center text-xs text-passive-1">
              Enter text to generate a QR code
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export type SerializedQrCodeNode = Spread<{ data: QrCodeData }, SerializedLexicalNode>

export class QrCodeNode extends DecoratorNode<React.JSX.Element> {
  __data: QrCodeData

  static getType(): string {
    return 'qr-code'
  }

  static clone(node: QrCodeNode): QrCodeNode {
    return new QrCodeNode(node.__data, node.__key)
  }

  constructor(data: QrCodeData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedQrCodeNode): QrCodeNode {
    return $createQrCodeNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedQrCodeNode {
    return { type: 'qr-code', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): QrCodeData {
    return this.getLatest().__data
  }

  setData(data: QrCodeData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.text
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <QrCodeComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createQrCodeNode(data: QrCodeData = DEFAULT_QR_CODE): QrCodeNode {
  return new QrCodeNode(clone(data))
}

export function $isQrCodeNode(node: LexicalNode | null | undefined): node is QrCodeNode {
  return node instanceof QrCodeNode
}
