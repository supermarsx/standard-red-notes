import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  $getNodeByKey,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import Icon from '@/Components/Icon/Icon'
import {
  buildFlowchartSource,
  createEmptyGraphModel,
  MERMAID_GRAPH_DIRECTIONS,
  MERMAID_TEMPLATES,
  MermaidGraphDirection,
  MermaidGraphEdge,
  MermaidGraphModel,
  MermaidGraphNode,
  nextNodeId,
  parseFlowchartSource,
} from './MermaidGraphBuilder'
import MermaidSvgViewport from './MermaidSvgViewport'
import { MermaidResizeHandle } from './MermaidBlockControls'
import { MermaidWidthUnit, normalizeMermaidHeight, normalizeMermaidWidth, parseMermaidWidth } from './MermaidWidth'
import {
  DEFAULT_MERMAID_THEME_MODE,
  DEFAULT_MERMAID_VIEW_MODE,
  mermaidAlignmentStyle,
  mermaidAppThemeIsDark,
  MermaidBuiltinTheme,
  MermaidMaxHeight,
  MermaidSettings,
  MermaidThemeMode,
  MermaidViewMode,
  normalizeMermaidViewMode,
  resolveMermaidMaxHeightPx,
  resolveMermaidSettings,
  resolveMermaidTheme,
} from './MermaidSettings'

const DEFAULT_MERMAID = 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]'

/**
 * 1: code only. 2: + theme/viewMode. 3: + width/height (t113). 4: + the shared
 * settings set — fit mode, maximum height, alignment, background, pan/zoom — and
 * `theme` widened to accept `app` (follow the application's own light/dark
 * theme). See MermaidSettings.ts, which owns every one of those.
 */
export const MERMAID_VERSION = 4

/** Debounce delay (ms) before re-rendering the preview while typing. */
const RENDER_DEBOUNCE_MS = 400

/**
 * Elements inside the block that own their own clicks. A click on one of these
 * must not be turned into a block selection, or the focus the user just asked
 * for would be taken away again.
 */
const INTERACTIVE_IN_BLOCK =
  'input, textarea, select, button, a, label, [data-mermaid-width-section="true"], [data-mermaid-settings]'

/**
 * Is the application showing a dark theme? Read from the live computed style, so
 * it follows whatever theme is installed rather than a hardcoded list. The
 * decision itself is the pure `mermaidAppThemeIsDark`; this only gathers its
 * inputs, and tolerates an environment with no layout engine (jsdom returns empty
 * strings, which falls through to the OS preference).
 */
function readAppThemeIsDark(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }
  const styles = window.getComputedStyle(document.documentElement)
  return mermaidAppThemeIsDark({
    themeType: styles.getPropertyValue('--sn-stylekit-theme-type'),
    backgroundColor: styles.getPropertyValue('--sn-stylekit-background-color'),
    prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true,
  })
}

// Lazily loaded mermaid singleton so the heavy library is code-split and only
// fetched when a diagram is actually rendered.
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

let renderSeq = 0

/**
 * The GRAPHICAL flowchart builder: a small form to add/remove nodes and edges
 * that regenerates flowchart mermaid source as it changes. It seeds its model
 * from the current code (best-effort parse of simple `graph TD` flowcharts);
 * if the code isn't a simple flowchart it starts from an empty model and notes
 * that hand-edited code isn't reverse-parsed.
 */
function GraphicalBuilder({
  code,
  onCodeChange,
}: {
  code: string
  onCodeChange: (next: string) => void
}): React.JSX.Element {
  // Parse once on mount (and whenever a parseable code arrives), then keep a
  // local model the form edits. We do not continuously re-parse outgoing code
  // to avoid fighting the user's typing in the builder.
  const [model, setModel] = useState<MermaidGraphModel>(() => parseFlowchartSource(code) ?? createEmptyGraphModel())
  const [parsedFromCode, setParsedFromCode] = useState<boolean>(() => parseFlowchartSource(code) != null)
  const lastEmittedRef = useRef<string>('')

  // If external code changes to something parseable and we didn't emit it,
  // re-seed the form so undo/redo and template selection stay reflected.
  useEffect(() => {
    if (code === lastEmittedRef.current) {
      return
    }
    const parsed = parseFlowchartSource(code)
    if (parsed) {
      setModel(parsed)
      setParsedFromCode(true)
    } else {
      setParsedFromCode(false)
    }
  }, [code])

  const commit = useCallback(
    (next: MermaidGraphModel) => {
      setModel(next)
      const source = buildFlowchartSource(next)
      lastEmittedRef.current = source
      onCodeChange(source)
    },
    [onCodeChange],
  )

  const addNode = useCallback(() => {
    const id = nextNodeId(model.nodes)
    commit({ ...model, nodes: [...model.nodes, { id, label: id }] })
  }, [model, commit])

  const updateNode = useCallback(
    (index: number, patch: Partial<MermaidGraphNode>) => {
      const nodes = model.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n))
      commit({ ...model, nodes })
    },
    [model, commit],
  )

  const removeNode = useCallback(
    (index: number) => {
      const removedId = model.nodes[index]?.id
      const nodes = model.nodes.filter((_, i) => i !== index)
      const edges = model.edges.filter((e) => e.from !== removedId && e.to !== removedId)
      commit({ ...model, nodes, edges })
    },
    [model, commit],
  )

  const addEdge = useCallback(() => {
    const first = model.nodes[0]?.id ?? ''
    const second = model.nodes[1]?.id ?? first
    commit({ ...model, edges: [...model.edges, { from: first, to: second, label: '' }] })
  }, [model, commit])

  const updateEdge = useCallback(
    (index: number, patch: Partial<MermaidGraphEdge>) => {
      const edges = model.edges.map((e, i) => (i === index ? { ...e, ...patch } : e))
      commit({ ...model, edges })
    },
    [model, commit],
  )

  const removeEdge = useCallback(
    (index: number) => {
      commit({ ...model, edges: model.edges.filter((_, i) => i !== index) })
    },
    [model, commit],
  )

  const setDirection = useCallback(
    (direction: MermaidGraphDirection) => {
      commit({ ...model, direction })
    },
    [model, commit],
  )

  const inputClass =
    'min-w-0 flex-1 rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'
  const selectClass =
    'rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'

  return (
    <div className="w-full p-2 text-sm" data-mermaid-graphical="true">
      {!parsedFromCode ? (
        <div
          className="border-warning bg-contrast text-foreground mb-2 rounded border p-1.5 text-xs"
          data-srn-print-exclude="true"
        >
          The current source isn’t a simple flowchart, so it can’t be loaded into the builder. Editing here will replace
          the source with a generated flowchart.
        </div>
      ) : null}

      <label className="mb-2 flex items-center gap-1">
        Direction
        <select
          className={selectClass}
          value={model.direction}
          onChange={(e) => setDirection(e.target.value as MermaidGraphDirection)}
          aria-label="Flowchart direction"
        >
          {MERMAID_GRAPH_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold">Nodes</span>
          <button
            type="button"
            className="border-border hover:bg-contrast rounded border px-2 py-0.5"
            onClick={addNode}
          >
            + Add node
          </button>
        </div>
        {model.nodes.length === 0 ? (
          <div className="text-passive-1 text-xs" data-srn-print-exclude="true">
            No nodes yet.
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          {model.nodes.map((node, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                className={inputClass + ' max-w-[6rem]'}
                value={node.id}
                spellCheck={false}
                onChange={(e) => updateNode(index, { id: e.target.value })}
                placeholder="id"
                aria-label={`Node ${index + 1} id`}
              />
              <input
                className={inputClass}
                value={node.label}
                onChange={(e) => updateNode(index, { label: e.target.value })}
                placeholder="Label"
                aria-label={`Node ${index + 1} label`}
              />
              <button
                type="button"
                className="text-danger hover:bg-contrast flex rounded px-1.5 py-1"
                onClick={() => removeNode(index)}
                aria-label={`Remove node ${index + 1}`}
                title="Remove node"
              >
                {/* A real glyph rather than the bare cross character this used to
                    print. The accessible name is the aria-label above either way,
                    so the mark itself is decorative and belongs in the icon set. */}
                <Icon type="close" size="small" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold">Edges</span>
          <button
            type="button"
            className="border-border hover:bg-contrast rounded border px-2 py-0.5 disabled:opacity-50"
            onClick={addEdge}
            disabled={model.nodes.length === 0}
          >
            + Add edge
          </button>
        </div>
        {model.edges.length === 0 ? (
          <div className="text-passive-1 text-xs" data-srn-print-exclude="true">
            No edges yet.
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          {model.edges.map((edge, index) => (
            <div key={index} className="flex items-center gap-1">
              <select
                className={selectClass}
                value={edge.from}
                onChange={(e) => updateEdge(index, { from: e.target.value })}
                aria-label={`Edge ${index + 1} from`}
              >
                {model.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
              {/* Purely decorative — the two selects it sits between are both
                  labelled "from"/"to", so this conveys no state and stays hidden
                  from assistive technology, as the character it replaces was. */}
              <span aria-hidden="true" className="flex">
                <Icon type="arrow-right" size="small" />
              </span>
              <select
                className={selectClass}
                value={edge.to}
                onChange={(e) => updateEdge(index, { to: e.target.value })}
                aria-label={`Edge ${index + 1} to`}
              >
                {model.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                value={edge.label}
                onChange={(e) => updateEdge(index, { label: e.target.value })}
                placeholder="Label (optional)"
                aria-label={`Edge ${index + 1} label`}
              />
              <button
                type="button"
                className="text-danger hover:bg-contrast flex rounded px-1.5 py-1"
                onClick={() => removeEdge(index)}
                aria-label={`Remove edge ${index + 1}`}
                title="Remove edge"
              >
                <Icon type="close" size="small" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MermaidComponent({
  code,
  settings,
  viewMode,
  width,
  height,
  nodeKey,
}: {
  code: string
  settings: MermaidSettings
  viewMode: MermaidViewMode
  width: string | undefined
  height: number | undefined
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  // Local draft so typing in the textarea stays snappy; committed to the node
  // (and debounce-rendered) as it changes.
  const [draft, setDraft] = useState(code)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Incremented to force a re-render even when the source/theme are unchanged
  // (the Reload button).
  const [reloadToken, setReloadToken] = useState(0)
  // Guards against a late async render overwriting a newer one.
  const renderTokenRef = useRef(0)

  // Keep the draft in sync when the node's code changes from the outside
  // (e.g. undo/redo, collaborative edits).
  useEffect(() => {
    setDraft(code)
  }, [code])

  const render = useCallback(
    async (source: string, activeTheme: MermaidBuiltinTheme) => {
      const token = ++renderTokenRef.current
      const trimmed = source.trim()
      if (!trimmed) {
        setSvg('')
        setError(null)
        return
      }
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: activeTheme,
          fontFamily: 'inherit',
        })
        const id = `mermaid-${nodeKey}-${renderSeq++}`
        const { svg: rendered } = await mermaid.render(id, trimmed)
        // Drop the result if a newer render started in the meantime.
        if (token !== renderTokenRef.current) {
          return
        }
        setSvg(rendered)
        setError(null)
      } catch (e) {
        if (token !== renderTokenRef.current) {
          return
        }
        // Keep the last good diagram; show the error inline so a bad keystroke
        // never crashes the editor.
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [nodeKey],
  )

  // Whether the APPLICATION is showing a dark theme, which is what the default
  // `app` theme mode follows. Re-read when the OS preference flips and when the
  // document element's own styling changes (how a theme is installed here), so a
  // theme switch re-renders the diagram instead of leaving a light chart in a
  // dark editor until the next keystroke.
  const [appIsDark, setAppIsDark] = useState(readAppThemeIsDark)
  useEffect(() => {
    const refresh = () => setAppIsDark(readAppThemeIsDark())
    refresh()
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', refresh)
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refresh)
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => {
      media?.removeEventListener?.('change', refresh)
      observer?.disconnect()
    }
  }, [])

  const activeTheme = resolveMermaidTheme(settings.themeMode, appIsDark)

  // Debounced render whenever the draft, resolved theme, or reload token changes.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void render(draft, activeTheme)
    }, RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [draft, activeTheme, reloadToken, render])

  // Invalidate any in-flight render when the component unmounts.
  useEffect(() => {
    return () => {
      renderTokenRef.current++
    }
  }, [])

  const persistCode = useCallback(
    (next: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setCode(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const onCodeChange = useCallback(
    (next: string) => {
      setDraft(next)
      persistCode(next)
    },
    [persistCode],
  )

  const reload = useCallback(() => {
    setReloadToken((t) => t + 1)
  }, [])

  // --- Selection gating for the size controls -------------------------------
  // The table's own selected-only control (TableCellActionMenuPlugin) renders
  // nothing until the Lexical selection resolves to a table cell. This is the
  // decorator-node spelling of that rule, as RemoteImageComponent does it
  // (RemoteImageComponent.tsx:109-130), with two deliberate differences — see
  // the handler below.
  const blockRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        const target = event.target as Element | null
        if (!target || !blockRef.current?.contains(target)) {
          return false
        }
        // (1) A click on one of the block's OWN controls changes no selection.
        // Unlike an image block, this one is full of real form fields — the
        // mermaid source textarea, the theme/template/view selects, the width
        // field — and moving the editor's selection on those clicks would pull
        // focus straight back out of whatever the user just clicked into. That
        // is also why nothing here calls `event.preventDefault()` or
        // `node.selectEnd()`: both would fight the focused field.
        const onOwnControl = typeof target.closest === 'function' && target.closest(INTERACTIVE_IN_BLOCK) !== null
        if (!onOwnControl) {
          // (2) Select, never toggle. The image block toggles, which would make
          // the controls vanish on a second click — exactly while being used.
          // Deferred to a macrotask so this nested update does not run inside
          // the command dispatch that is already updating the editor.
          setTimeout(() => setSelected(true))
        }
        // (3) Consume the click EITHER WAY. Handing it back to Lexical would let
        // its own click handling put a range selection in the editor, which both
        // dismisses these controls while they are being used and moves the caret
        // out of the field just clicked. Because `preventDefault` is never
        // called, the browser still focuses that field natively.
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, setSelected])

  const onResizeEnd = useCallback(
    (nextWidth: string | undefined, nextHeight: number | undefined) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setWidth(nextWidth)
          node.setHeight(nextHeight)
        }
      })
    },
    [editor, nodeKey],
  )

  const widthUnit: MermaidWidthUnit = parseMermaidWidth(width)?.unit ?? '%'

  // Replace the entire source from the Templates dropdown.
  const applyTemplate = useCallback(
    (templateId: string) => {
      const source = MERMAID_TEMPLATES.find((t) => t.id === templateId)?.source
      if (source == null) {
        return
      }
      setDraft(source)
      persistCode(source)
    },
    [persistCode],
  )

  const showCode = viewMode === 'split' || viewMode === 'code'
  const showPreview = viewMode === 'split' || viewMode === 'preview'
  const showGraphical = viewMode === 'graphical'

  return (
    <div
      ref={blockRef}
      className="border-border bg-default my-2 rounded border"
      data-mermaid-block="true"
      data-super-widget-layout="canvas"
      // `width` is undefined unless the user set one — fitting is the DEFAULT,
      // not a stored number — and `maxWidth` means a stored pixel width can
      // never make the note scroll horizontally. The alignment margins only bite
      // on a block narrower than the column, which is the only case with slack.
      style={{ width, maxWidth: '100%', ...mermaidAlignmentStyle(settings.alignment) }}
    >
      {/* THE CHART'S OWN TOP BAR — the block's identity, plus the two actions on
          its SOURCE: pick a template, re-render. No configuration. Every mermaid
          setting now has exactly ONE home, the editor toolbar's Mermaid section
          (ToolbarPlugin), which appears while the diagram is selected; the user
          asked for it not to be offered twice. The shared control definitions
          (MermaidSettingsPanel, and `mermaidSettingsControls`, which the toolbar
          renders from) are untouched, and its `bar` arrangement is still built
          and still tested — restoring this surface, or a chosen subset of it, is
          a matter of mounting that component again. */}
      <div
        className="border-border text-passive-1 flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1 text-xs"
        data-mermaid-top-bar="true"
      >
        <span className="font-semibold">Mermaid diagram</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            Templates
            <select
              className="border-border bg-default text-foreground focus:border-info rounded border px-1 py-0.5 outline-none"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  applyTemplate(e.target.value)
                }
              }}
              aria-label="Insert a template diagram"
            >
              <option value="" disabled>
                Choose…
              </option>
              {MERMAID_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="hover:bg-contrast rounded px-2 py-0.5"
            onClick={reload}
            title="Re-render the diagram"
          >
            Reload
          </button>
        </div>
      </div>

      <div className={'flex ' + (viewMode === 'split' ? 'flex-col md:flex-row' : 'flex-col')}>
        {showGraphical ? (
          <div className="border-border w-full border-b md:border-b-0">
            <GraphicalBuilder code={draft} onCodeChange={onCodeChange} />
          </div>
        ) : null}

        {showCode ? (
          <div
            className={'flex flex-col ' + (viewMode === 'split' ? 'md:border-border md:w-1/2 md:border-r' : 'w-full')}
          >
            <textarea
              className="bg-default text-foreground w-full resize-y p-2 font-mono text-sm outline-none"
              rows={Math.max(6, draft.split('\n').length + 1)}
              value={draft}
              spellCheck={false}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="Enter mermaid source…"
              aria-label="Mermaid source"
            />
          </div>
        ) : null}

        {showPreview ? (
          <div className={'p-2 ' + (viewMode === 'split' ? 'md:w-1/2' : 'w-full')}>
            {svg ? (
              // An unpadded wrapper so its measured height IS the preview box's
              // height; the resize handle's live feedback and the persisted
              // `height` then refer to the same box.
              <div ref={previewRef}>
                <MermaidSvgViewport
                  svg={svg}
                  heightOverride={height}
                  fitMode={settings.fitMode}
                  // THE configurable maximum that replaced the hardcoded 480:
                  // resolved from the node's own setting, `null` when the user
                  // chose "No limit", and otherwise a share of the window.
                  maxHeightPx={resolveMermaidMaxHeightPx(
                    settings.maxHeight,
                    typeof window === 'undefined' ? undefined : window.innerHeight,
                  )}
                  zoomPan={settings.zoomPan}
                  background={settings.background}
                >
                  <MermaidResizeHandle
                    active={isSelected}
                    widthTargetRef={blockRef}
                    heightTargetRef={previewRef}
                    unit={widthUnit}
                    onResizeEnd={onResizeEnd}
                  />
                </MermaidSvgViewport>
              </div>
            ) : (
              !error && (
                <div className="text-passive-1 text-sm" data-srn-print-exclude="true">
                  Empty diagram
                </div>
              )
            )}
            {error ? (
              <div className="text-danger mt-1 text-xs whitespace-pre-wrap" data-srn-print-exclude="true" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export type SerializedMermaidNode = Spread<
  {
    code: string
    /**
     * The theme MODE. Versions 2-3 stored one of mermaid's own theme names here;
     * version 4 widened it to include `app` (follow the application's theme) and
     * kept the field name, so an older note's stored theme is still exactly the
     * theme it gets — see `resolveMermaidThemeMode`.
     */
    theme: MermaidThemeMode
    viewMode: MermaidViewMode
    /** Normalized CSS width (`"50%"`, `"420px"`); absent means "fit". */
    width?: string
    /** Preview-box height in px; absent means "auto-fit". */
    height?: number
    /** Version 4 — see MermaidSettings.ts. Absent fields take their defaults. */
    fitMode?: MermaidSettings['fitMode']
    /** A px number, or `"none"`. Absent means "follow the window". */
    maxHeight?: MermaidMaxHeight
    alignment?: MermaidSettings['alignment']
    background?: MermaidSettings['background']
    zoomPan?: boolean
  },
  SerializedLexicalNode
>

/** The version-4 settings a caller may seed, other than the theme mode. */
export type MermaidExtraSettings = Partial<Omit<MermaidSettings, 'themeMode'>>

export class MermaidNode extends DecoratorNode<React.JSX.Element> {
  __code: string
  __viewMode: MermaidViewMode
  /**
   * Every configurable setting, already resolved: the ONE place the block's own
   * top bar and the editor toolbar's Mermaid section both read and write. The
   * theme mode lives in here too (it is a setting like any other); the SERIALIZED
   * field keeps its historical name `theme`.
   */
  __settings: MermaidSettings
  /** Normalized CSS width, or undefined for "fit the container". */
  __width: string | undefined
  /** Preview-box height in px, or undefined for "auto-fit". */
  __height: number | undefined

  static getType(): string {
    return 'mermaid'
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(
      node.__code,
      node.__settings.themeMode,
      node.__viewMode,
      node.__width,
      node.__height,
      node.__settings,
      node.__key,
    )
  }

  constructor(
    code: string,
    themeMode: MermaidThemeMode = DEFAULT_MERMAID_THEME_MODE,
    viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE,
    width?: string,
    height?: number,
    settings?: MermaidExtraSettings,
    key?: NodeKey,
  ) {
    super(key)
    this.__code = code
    this.__viewMode = viewMode
    // THE single validation point for the settings, for exactly the reason the
    // size has one: every creation path funnels through here, and each field is a
    // SYNCED value an older build or a hand edit may have written. Anything
    // unparseable becomes its default rather than reaching a style attribute or
    // mermaid's own config.
    this.__settings = resolveMermaidSettings({ ...settings, themeMode })
    // THE single validation point for an incoming size, deliberately not
    // duplicated in importJSON: every creation path — $createMermaidNode,
    // clone(), importJSON — funnels through here, and a stored size is a SYNCED
    // value another client, an older build or a hand edit may have written. It
    // is re-parsed and re-clamped, and anything unparseable becomes `undefined`
    // (fit the container) rather than reaching a style attribute. The only other
    // way `__width`/`__height` can change is setWidth/setHeight, which normalize
    // the same way.
    this.__width = normalizeMermaidWidth(width)
    this.__height = normalizeMermaidHeight(height)
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    // Backward-compatible: old nodes (version 1) stored only `code`; theme and
    // viewMode are absent and fall back to defaults. Some very old serializations
    // may even be a bare string — guard against that too.
    const raw = serializedNode as unknown
    if (typeof raw === 'string') {
      return $createMermaidNode(raw)
    }
    const code = typeof serializedNode.code === 'string' ? serializedNode.code : DEFAULT_MERMAID
    const viewMode = normalizeMermaidViewMode(serializedNode.viewMode) ?? DEFAULT_MERMAID_VIEW_MODE
    // The stored size and settings are handed straight to the constructor, which
    // is the one place that parses and clamps them (see the comment there).
    // Normalizing here as well would be dead code that makes the real guard
    // untestable: with two layers, removing either one changes nothing
    // observable. The theme is passed through unvalidated for the same reason —
    // `resolveMermaidSettings` is what decides whether a stored theme is one it
    // recognizes, and what an unrecognized one falls back to.
    return $createMermaidNode(
      code,
      serializedNode.theme as MermaidThemeMode,
      viewMode,
      serializedNode.width,
      serializedNode.height,
      {
        fitMode: serializedNode.fitMode,
        maxHeight: serializedNode.maxHeight,
        alignment: serializedNode.alignment,
        background: serializedNode.background,
        zoomPan: serializedNode.zoomPan,
      },
    )
  }

  exportJSON(): SerializedMermaidNode {
    return {
      type: 'mermaid',
      version: MERMAID_VERSION,
      code: this.__code,
      theme: this.__settings.themeMode,
      viewMode: this.__viewMode,
      width: this.__width,
      height: this.__height,
      fitMode: this.__settings.fitMode,
      // Written only when the user actually chose one: absent means "follow the
      // window", and writing the resolved pixel number would freeze today's
      // window height into the note.
      maxHeight: this.__settings.maxHeight,
      alignment: this.__settings.alignment,
      background: this.__settings.background,
      zoomPan: this.__settings.zoomPan,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre')
    element.setAttribute('data-lexical-mermaid', 'true')
    const codeEl = document.createElement('code')
    codeEl.className = 'language-mermaid'
    codeEl.textContent = this.__code
    element.appendChild(codeEl)
    return { element }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getCode(): string {
    return this.getLatest().__code
  }

  setCode(code: string): void {
    this.getWritable().__code = code
  }

  /** The theme MODE (`app`, or one of mermaid's own theme names). */
  getTheme(): MermaidThemeMode {
    return this.getLatest().__settings.themeMode
  }

  setTheme(themeMode: MermaidThemeMode): void {
    this.setSettings({ themeMode })
  }

  /** Every setting, resolved. The shape the toolbar section renders from. */
  getSettings(): MermaidSettings {
    return this.getLatest().__settings
  }

  /**
   * Apply a partial settings change. Re-resolves the whole object, so a setter is
   * no more trusted than an import: this is the only other way `__settings` can
   * change, and it normalizes the same way the constructor does.
   */
  setSettings(patch: Partial<MermaidSettings>): void {
    const writable = this.getWritable()
    const merged = { ...writable.__settings, ...patch }
    writable.__settings = resolveMermaidSettings(merged)
  }

  getViewMode(): MermaidViewMode {
    return this.getLatest().__viewMode
  }

  setViewMode(viewMode: MermaidViewMode): void {
    this.getWritable().__viewMode = viewMode
  }

  getWidth(): string | undefined {
    return this.getLatest().__width
  }

  /** Normalizes on write, so `__width` is never a value nothing validated. */
  setWidth(width: string | undefined): void {
    this.getWritable().__width = normalizeMermaidWidth(width)
  }

  getHeight(): number | undefined {
    return this.getLatest().__height
  }

  setHeight(height: number | undefined): void {
    this.getWritable().__height = normalizeMermaidHeight(height)
  }

  getTextContent(): string {
    return '```mermaid\n' + this.__code + '\n```'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return (
      <MermaidComponent
        code={this.__code}
        settings={this.__settings}
        viewMode={this.__viewMode}
        width={this.__width}
        height={this.__height}
        nodeKey={this.getKey()}
      />
    )
  }
}

export function $createMermaidNode(
  code = DEFAULT_MERMAID,
  themeMode: MermaidThemeMode = DEFAULT_MERMAID_THEME_MODE,
  viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE,
  width?: string,
  height?: number,
  settings?: MermaidExtraSettings,
): MermaidNode {
  return new MermaidNode(code, themeMode, viewMode, width, height, settings)
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode
}
