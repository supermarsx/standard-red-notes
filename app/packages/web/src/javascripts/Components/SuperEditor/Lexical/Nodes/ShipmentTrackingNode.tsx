import * as React from 'react'
import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey,
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'

export const SHIPMENT_TRACKING_VERSION = 1
export const SHIPMENT_TRACKING_MAX_LABEL_LENGTH = 80
export const SHIPMENT_TRACKING_MAX_STORED_NUMBER_LENGTH = 80
export const GLOBAL_SHIPMENT_TRACKING_ORIGIN = 'https://t.17track.net'

export type ShipmentTrackingData = {
  version: number
  label: string
  trackingNumber: string
}

export const DEFAULT_SHIPMENT_TRACKING_DATA: ShipmentTrackingData = {
  version: SHIPMENT_TRACKING_VERSION,
  label: '',
  trackingNumber: '',
}

const stripFormattingControls = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')

const normalizeLabel = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  return stripFormattingControls(value).replace(/\s+/gu, ' ').trim().slice(0, SHIPMENT_TRACKING_MAX_LABEL_LENGTH)
}

/**
 * Tracking numbers are commonly copied with visual spaces. Remove whitespace,
 * but otherwise preserve the user's text so an unfamiliar future format stays
 * visible and editable. Link creation applies the stricter allowlist below.
 */
export const normalizeTrackingNumber = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  return stripFormattingControls(value).replace(/\s+/gu, '').trim().slice(0, SHIPMENT_TRACKING_MAX_STORED_NUMBER_LENGTH)
}

export const isValidTrackingNumber = (value: string): boolean => /^[A-Za-z0-9-]{5,50}$/u.test(value)

/**
 * Build 17TRACK's verified fragment deep-link. A URL object pins the origin and
 * path; URLSearchParams owns the fragment encoding. No serialized/user-provided
 * URL is ever navigated to.
 */
export const buildGlobalShipmentTrackingUrl = (value: string): string | undefined => {
  const trackingNumber = normalizeTrackingNumber(value)
  if (!isValidTrackingNumber(trackingNumber)) {
    return undefined
  }

  const url = new URL('/en', GLOBAL_SHIPMENT_TRACKING_ORIGIN)
  url.hash = new URLSearchParams({ nums: trackingNumber }).toString()
  return url.toString()
}

export const normalizeShipmentTrackingData = (data: unknown): ShipmentTrackingData => {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_SHIPMENT_TRACKING_DATA }
  }
  const candidate = data as Partial<ShipmentTrackingData>
  return {
    version: SHIPMENT_TRACKING_VERSION,
    label: normalizeLabel(candidate.label),
    trackingNumber: normalizeTrackingNumber(candidate.trackingNumber),
  }
}

const cloneShipmentTrackingData = (data: unknown): ShipmentTrackingData => ({ ...normalizeShipmentTrackingData(data) })

/** Plain-text fallback used by search and every non-DOM export path. */
export const shipmentTrackingTextContent = (data: unknown): string => {
  const normalized = normalizeShipmentTrackingData(data)
  if (!normalized.trackingNumber) {
    return ''
  }
  return normalized.label
    ? `${normalized.label}: ${normalized.trackingNumber}`
    : `Shipment tracking: ${normalized.trackingNumber}`
}

export type ShipmentTrackingViewProps = {
  data: ShipmentTrackingData
  onChange: (data: ShipmentTrackingData) => void
}

/** Provider-free view exported so its privacy and print contract can be tested directly. */
export function ShipmentTrackingView({ data, onChange }: ShipmentTrackingViewProps): React.JSX.Element {
  const sectionLabelId = useId()
  const formatDescriptionId = useId()
  const trackingInputRef = useRef<HTMLInputElement>(null)
  const focusEditorOnOpenRef = useRef(false)
  const normalized = useMemo(() => normalizeShipmentTrackingData(data), [data])
  const trackingUrl = useMemo(
    () => buildGlobalShipmentTrackingUrl(normalized.trackingNumber),
    [normalized.trackingNumber],
  )
  const [editing, setEditing] = useState(() => !trackingUrl)
  const [labelDraft, setLabelDraft] = useState(normalized.label)
  const [numberDraft, setNumberDraft] = useState(normalized.trackingNumber)
  const [saveAttempted, setSaveAttempted] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    setLabelDraft(normalized.label)
    setNumberDraft(normalized.trackingNumber)
    setCopyState('idle')
  }, [normalized.label, normalized.trackingNumber])

  useEffect(() => {
    if (!trackingUrl) {
      setEditing(true)
    }
  }, [trackingUrl])

  useEffect(() => {
    if (editing && focusEditorOnOpenRef.current) {
      focusEditorOnOpenRef.current = false
      trackingInputRef.current?.focus()
    }
  }, [editing])

  const normalizedNumberDraft = normalizeTrackingNumber(numberDraft)
  const numberDraftIsValid = isValidTrackingNumber(normalizedNumberDraft)
  const shouldShowValidation = saveAttempted || numberDraft.length > 0

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setSaveAttempted(true)
      if (!numberDraftIsValid) {
        return
      }
      onChange(
        normalizeShipmentTrackingData({
          version: SHIPMENT_TRACKING_VERSION,
          label: labelDraft,
          trackingNumber: normalizedNumberDraft,
        }),
      )
      setEditing(false)
      setSaveAttempted(false)
    },
    [labelDraft, normalizedNumberDraft, numberDraftIsValid, onChange],
  )

  const cancelEditing = useCallback(() => {
    setLabelDraft(normalized.label)
    setNumberDraft(normalized.trackingNumber)
    setSaveAttempted(false)
    setEditing(!trackingUrl)
  }, [normalized.label, normalized.trackingNumber, trackingUrl])

  const copyTrackingNumber = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable')
      }
      await navigator.clipboard.writeText(normalized.trackingNumber)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }, [normalized.trackingNumber])

  const startEditing = useCallback(() => {
    focusEditorOnOpenRef.current = true
    setEditing(true)
  }, [])

  const accessibleShipmentName = normalized.label || normalized.trackingNumber

  return (
    <section
      aria-labelledby={sectionLabelId}
      className="border-border bg-default my-2 overflow-hidden rounded-lg border"
      data-shipment-tracking-block="true"
      data-super-widget-layout="compact"
    >
      <header className="border-border flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0">
          <div id={sectionLabelId} className="text-foreground text-xs font-semibold tracking-wide uppercase">
            Shipment tracking
          </div>
          {normalized.label ? (
            <div className="text-passive-1 truncate text-sm" data-shipment-tracking-label="true">
              {normalized.label}
            </div>
          ) : null}
        </div>
        {trackingUrl ? (
          <span
            className="bg-info-backdrop text-info rounded-full px-2 py-0.5 text-xs font-medium"
            data-srn-print-exclude="true"
          >
            Ready to check
          </span>
        ) : null}
      </header>

      {normalized.trackingNumber ? (
        <div className="px-3 py-3" data-shipment-tracking-summary="true">
          <div className="text-passive-1 mb-1 text-xs">Tracking number</div>
          <code className="text-foreground block overflow-x-auto font-mono text-base" dir="ltr">
            {normalized.trackingNumber}
          </code>
        </div>
      ) : (
        <div className="text-passive-1 px-3 py-3 text-sm" data-srn-print-exclude="true">
          Add a tracking number to create a private, on-demand lookup.
        </div>
      )}

      {editing ? (
        <form
          className="border-border flex flex-col gap-3 border-t px-3 py-3"
          data-srn-print-exclude="true"
          onSubmit={submit}
        >
          <label className="text-passive-1 flex flex-col gap-1 text-xs">
            Label (optional)
            <input
              className="border-border bg-default text-foreground focus:border-info rounded border px-2 py-1.5 text-sm outline-none"
              aria-label="Shipment label"
              maxLength={SHIPMENT_TRACKING_MAX_LABEL_LENGTH}
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
            />
          </label>
          <label className="text-passive-1 flex flex-col gap-1 text-xs">
            Tracking number
            <input
              ref={trackingInputRef}
              className="border-border bg-default text-foreground focus:border-info rounded border px-2 py-1.5 font-mono text-sm outline-none"
              aria-describedby={formatDescriptionId}
              aria-invalid={shouldShowValidation && !numberDraftIsValid}
              aria-label="Shipment tracking number"
              autoCapitalize="characters"
              autoComplete="off"
              dir="ltr"
              maxLength={SHIPMENT_TRACKING_MAX_STORED_NUMBER_LENGTH}
              spellCheck={false}
              value={numberDraft}
              onChange={(event) => setNumberDraft(event.target.value)}
            />
          </label>
          <p
            id={formatDescriptionId}
            className={shouldShowValidation && !numberDraftIsValid ? 'text-danger text-xs' : 'text-passive-1 text-xs'}
            role={shouldShowValidation && !numberDraftIsValid ? 'alert' : undefined}
          >
            Use 5–50 letters, numbers, or hyphens. Spaces copied from a label are removed.
          </p>
          <div className="flex justify-end gap-2">
            {trackingUrl ? (
              <button
                type="button"
                className="border-border hover:bg-contrast rounded border px-3 py-1.5 text-sm"
                onClick={cancelEditing}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              className="bg-info text-info-contrast rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={!numberDraftIsValid}
            >
              Save shipment
            </button>
          </div>
        </form>
      ) : trackingUrl ? (
        <div
          className="border-border flex flex-wrap items-center gap-2 border-t px-3 py-2"
          data-srn-print-exclude="true"
        >
          <a
            aria-label={`Track ${accessibleShipmentName} globally`}
            className="bg-info text-info-contrast rounded px-3 py-1.5 text-sm font-medium"
            data-shipment-track-action="global"
            href={trackingUrl}
            referrerPolicy="no-referrer"
            rel="noopener noreferrer"
            target="_blank"
          >
            Track globally
          </a>
          <button
            type="button"
            aria-label={`Copy tracking number for ${accessibleShipmentName}`}
            className="border-border hover:bg-contrast rounded border px-3 py-1.5 text-sm"
            onClick={copyTrackingNumber}
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy number'}
          </button>
          <button
            type="button"
            aria-label={`Edit shipment tracking for ${accessibleShipmentName}`}
            className="hover:bg-contrast rounded px-3 py-1.5 text-sm"
            onClick={startEditing}
          >
            Edit
          </button>
          <p className="text-passive-1 basis-full text-xs">
            The number is sent to 17TRACK only when you open the global lookup.
          </p>
          <span className="text-passive-1 basis-full text-xs" aria-live="polite" role="status">
            {copyState === 'copied'
              ? 'Tracking number copied.'
              : copyState === 'failed'
                ? 'Copy failed. Select the tracking number above and copy it manually.'
                : ''}
          </span>
        </div>
      ) : null}
    </section>
  )
}

function ShipmentTrackingComponent({ data, nodeKey }: { data: ShipmentTrackingData; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext()

  const updateData = useCallback(
    (nextData: ShipmentTrackingData) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isShipmentTrackingNode(node)) {
          node.setData(nextData)
        }
      })
    },
    [editor, nodeKey],
  )

  return <ShipmentTrackingView data={data} onChange={updateData} />
}

export type SerializedShipmentTrackingNode = Spread<{ data: ShipmentTrackingData }, SerializedLexicalNode>

export class ShipmentTrackingNode extends DecoratorNode<React.JSX.Element> {
  __data: ShipmentTrackingData

  static getType(): string {
    return 'shipment-tracking'
  }

  static clone(node: ShipmentTrackingNode): ShipmentTrackingNode {
    return new ShipmentTrackingNode(normalizeShipmentTrackingData(node.__data), node.__key)
  }

  constructor(data: ShipmentTrackingData, key?: NodeKey) {
    super(key)
    this.__data = normalizeShipmentTrackingData(data)
  }

  static importJSON(serializedNode: SerializedShipmentTrackingNode): ShipmentTrackingNode {
    return $createShipmentTrackingNode(serializedNode.data)
  }

  exportJSON(): SerializedShipmentTrackingNode {
    const data = normalizeShipmentTrackingData(this.getLatest().__data)
    return {
      type: ShipmentTrackingNode.getType(),
      version: 1,
      data: cloneShipmentTrackingData(data),
    }
  }

  exportDOM(): DOMExportOutput {
    const data = normalizeShipmentTrackingData(this.getLatest().__data)
    const element = document.createElement('div')
    element.setAttribute('data-shipment-tracking-block', 'true')
    element.textContent = shipmentTrackingTextContent(data)
    return { element }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    element.style.display = 'contents'
    return element
  }

  updateDOM(): false {
    return false
  }

  getData(): ShipmentTrackingData {
    return cloneShipmentTrackingData(normalizeShipmentTrackingData(this.getLatest().__data))
  }

  setData(data: ShipmentTrackingData): void {
    this.getWritable().__data = normalizeShipmentTrackingData(data)
  }

  getTextContent(): string {
    return shipmentTrackingTextContent(normalizeShipmentTrackingData(this.getLatest().__data))
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <ShipmentTrackingComponent data={normalizeShipmentTrackingData(this.__data)} nodeKey={this.getKey()} />
  }
}

export function $createShipmentTrackingNode(
  data: ShipmentTrackingData = DEFAULT_SHIPMENT_TRACKING_DATA,
): ShipmentTrackingNode {
  return new ShipmentTrackingNode(cloneShipmentTrackingData(data))
}

export function $isShipmentTrackingNode(node: LexicalNode | null | undefined): node is ShipmentTrackingNode {
  return node instanceof ShipmentTrackingNode
}
