/**
 * Standard Red Notes — the mermaid block's SOURCE pane, with syntax
 * highlighting.
 *
 *
 * WHY A `<pre>` UNDERLAY AND NOT SOMETHING CLEVERER
 *
 * A `<textarea>` cannot be styled internally: it has no child nodes to wrap, so
 * there is nowhere to hang a colour. The three ways out, and why this is the one:
 *
 *   1. A `contenteditable` div with spans in it. Gives real inline colouring,
 *      and loses: native undo/redo (nothing in this block is wired to Lexical's
 *      history plugin, and `document.execCommand('undo')` across a
 *      React-controlled tree is unreliable), IME composition over re-rendered
 *      children (a compose session whose DOM is replaced mid-composition
 *      aborts), and newline semantics (Enter in a contenteditable produces
 *      whatever the browser feels like). Every one of those is a regression a
 *      user would notice before they noticed the colours.
 *   2. A code-editor dependency (CodeMirror, Monaco, Prism's live editor).
 *      Correct, and a hard no: adding a package to `app/` can turn the contract
 *      gates red, and this is a 300-line problem.
 *   3. THIS. The real `<textarea>` stays, exactly as it was, with
 *      `color: transparent` and a visible `caret-color`; a `<pre>` holding the
 *      same text, with the same metrics, sits behind it and is scrolled in
 *      lockstep. Editing is 100% native, because the editable element is
 *      unchanged. The cost is that the two elements must agree on every
 *      property that affects where a glyph lands — a finite list, enumerated in
 *      the `.MermaidCode__layer` rule in `Theme/mermaid-code.scss`, declared
 *      once and applied to both.
 *
 * What this preserves, and how each was checked (jsdom has no layout engine and
 * can see none of it; the numbers are from headless Chrome):
 *
 *   - CARET POSITION. A probe compares the caret's client rect inside the
 *     textarea with the rect of the same character in the underlay, at many
 *     offsets and several scroll positions.
 *   - UNDO/REDO, CLIPBOARD, SELECTION, IME, autocorrect. Untouched by
 *     construction: the element receiving keystrokes is the same `<textarea>`
 *     with the same `value`/`onChange` contract. The underlay is `aria-hidden`,
 *     `pointer-events: none` and `user-select: none`, so it is out of the
 *     accessibility tree, unclickable and unselectable.
 *   - SELECTION VISIBILITY. The one thing that does NOT come for free: the
 *     textarea paints its selection highlight above the underlay, so an opaque
 *     highlight would hide the coloured text. The stylesheet gives the
 *     selection a translucent background so the glyphs read through it.
 *   - TABS. `tab-size` is declared on both layers rather than inherited: the
 *     editor root sets `tab-size: 2` and a `<textarea>`'s UA default is 8, so
 *     leaving it to inheritance is exactly how a tab-indented source drifts.
 *   - MOBILE. `autoCorrect`, `autoCapitalize`, `autoComplete` and `spellCheck`
 *     are off, as they were, plus `data-gramm="false"` for Grammarly, which
 *     injects its own overlay into a textarea and would fight this one.
 *
 *
 * WHY PER-LINE MEMOISATION
 *
 * The naive version re-renders every span on every keystroke. On a 600-line
 * source that is thousands of React elements per character typed. Splitting the
 * tokens into lines and memoising each line on its own text means a keystroke
 * re-renders ONE line's spans and does a props-equality check on the rest.
 */
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, type ChangeEvent } from 'react'
import {
  MERMAID_TOKEN_CLASS,
  detectMermaidSyntaxFamily,
  tokenizeMermaidByLine,
  type MermaidSyntaxFamily,
  type MermaidToken,
  type MermaidTokenizedLine,
} from './MermaidSyntax'
import { useMermaidTokenPalette } from './MermaidTokenPalette'

/**
 * The class carrying every property that decides WHERE a glyph lands. Both
 * layers get it, and they get it from the same rule, so the two cannot drift
 * apart by someone changing a Tailwind class on one of them.
 */
export const MERMAID_CODE_LAYER_CLASS = 'MermaidCode__layer'

/**
 * One block per source line. See MermaidCodeLine for why the underlay is
 * blocks-without-newlines rather than one continuous flow.
 */
export const MERMAID_CODE_LINE_CLASS = 'MermaidCode__line'

/** Hooks a probe (and a spec) finds the three elements by. */
export const MERMAID_CODE_PANE_ATTRIBUTE = 'data-mermaid-code-pane'
export const MERMAID_CODE_UNDERLAY_ATTRIBUTE = 'data-mermaid-code-underlay'
export const MERMAID_CODE_INPUT_ATTRIBUTE = 'data-mermaid-code-input'

type MermaidCodePaneProps = {
  /** The source being edited. Controlled, exactly as the bare textarea was. */
  value: string
  onChange: (value: string) => void
  /** The live preference. `false` renders the original bare textarea. */
  highlight: boolean
  placeholder?: string
  ariaLabel?: string
}

/**
 * One line's worth of spans.
 *
 * The comparator is custom because `tokens` is a fresh array on every
 * tokenisation, so the default shallow compare would never match. Comparing
 * `text` alone is sound — the tokens are a pure function of the line's text and
 * the diagram family — which is why `familyToken` is in the props: it is the
 * only other input, and it changes whenever the declaring line does.
 */
const MermaidCodeLine = memo(
  function MermaidCodeLine({ text, tokens }: { text: string; tokens: MermaidToken[]; family: MermaidSyntaxFamily }) {
    // ONE BLOCK PER LINE, and no newline characters anywhere in the underlay.
    //
    // The first version was a single continuous `pre-wrap` flow with the
    // newlines in it. It was correct and it was slow: a text change anywhere
    // dirties that whole inline flow, so Chrome re-laid out all 2 100 spans of
    // a 600-line source on every keystroke. Measured keystroke-to-frame on
    // that version was 21.5ms p50 against 8.6ms with highlighting off. Layout
    // is per-block, so giving each line its own block confines a keystroke's
    // layout to the line that changed.
    //
    // It is also the more correct structure. A `<pre>` gives a trailing empty
    // line no height, so the old version needed a sentinel newline to stop the
    // underlay being one row shorter than the textarea; a block per line gives
    // a source ending in a newline its own empty final block, exactly as the
    // textarea shows a trailing empty line. `.MermaidCode__line`'s
    // `min-height` is what makes that empty block one row tall.
    if (tokens.length === 0) {
      return <span className={MERMAID_CODE_LINE_CLASS}>{text}</span>
    }
    return (
      <span className={MERMAID_CODE_LINE_CLASS}>
        {tokens.map((token, index) => {
          const slice = text.slice(token.start, token.end)
          const className = MERMAID_TOKEN_CLASS[token.type]
          // An unclassified run becomes a bare text node, not an empty span:
          // no element at all is the one thing guaranteed to lay out exactly
          // like the same characters inside the textarea.
          return className ? (
            <span key={index} className={className}>
              {slice}
            </span>
          ) : (
            <Fragment key={index}>{slice}</Fragment>
          )
        })}
      </span>
    )
  },
  (previous, next) => previous.text === next.text && previous.family === next.family,
)

export default function MermaidCodePane({
  value,
  onChange,
  highlight,
  placeholder = 'Enter mermaid source…',
  ariaLabel = 'Mermaid source',
}: MermaidCodePaneProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const underlayRef = useRef<HTMLPreElement>(null)

  // The token colours, DERIVED from the live theme rather than mapped straight
  // from its tokens — because on a light theme the raw mapping measured five of
  // eight classes below WCAG AA and three below 2.2:1. See
  // MermaidTokenPalette.ts for the numbers and the derivation. `undefined` when
  // the cascade cannot be read (no layout engine, print), in which case the
  // declared defaults in `mermaid-code.scss` paint the pane.
  const paletteStyle = useMermaidTokenPalette(highlight)

  // THE other input to a line's tokens, and the reason a per-line cache is
  // sound at all. It must be the family ITSELF and not a stand-in such as the
  // first line's text: with the first line's text, typing anywhere in that one
  // line invalidated all N lines and re-rendered the whole underlay — for an
  // edit that almost never changes the diagram type.
  //
  // It is computed HERE and handed to the tokenizer, rather than letting the
  // tokenizer detect it again, so the detection pass runs once per keystroke
  // instead of twice.
  const family = useMemo(
    (): MermaidSyntaxFamily => (highlight ? detectMermaidSyntaxFamily(value) : 'unknown'),
    [highlight, value],
  )

  // One tokenisation pass per source change, memoised so a re-render that did
  // not change the source (a parent state update, a theme switch) is free.
  const lines = useMemo(() => (highlight ? tokenizeMermaidByLine(value, family) : null), [family, highlight, value])

  /**
   * THE per-keystroke cost control: one React element per line, REUSED by
   * identity whenever that line's text and the diagram family are unchanged.
   *
   * `memo` with a text-only comparator was the first attempt and was not
   * enough. Returning a fresh element for every line still means N
   * `createElement` allocations and N comparator calls, and React still has to
   * walk N child fibers to bail out of each one. Handing back the IDENTICAL
   * element object instead takes React's cheapest path — `oldProps ===
   * newProps`, decided before the component or its comparator is consulted.
   *
   * Keyed by INDEX, not by text: typing inside a line is the common case and
   * keeps every other index valid, whereas duplicate lines are everywhere in a
   * mermaid source (`end`, `direction TB`) and a text-keyed cache would alias
   * them. Inserting or deleting a line shifts the indices below it and costs
   * one full pass, which is the correct trade.
   *
   * Writing the ref during render is safe here because the cache is a pure
   * function of the props: a double-invoked render rebuilds exactly the same
   * entries.
   */
  const lineCacheRef = useRef<{ text: string; family: MermaidSyntaxFamily; element: React.JSX.Element }[]>([])
  const children = useMemo(() => {
    if (!lines) {
      lineCacheRef.current = []
      return null
    }
    const previous = lineCacheRef.current
    const next = lines.map((line: MermaidTokenizedLine, index: number) => {
      const hit = previous[index]
      if (hit && hit.text === line.text && hit.family === family) {
        return hit
      }
      return {
        text: line.text,
        family,
        element: <MermaidCodeLine key={index} text={line.text} tokens={line.tokens} family={family} />,
      }
    })
    lineCacheRef.current = next
    return next.map((entry) => entry.element)
  }, [family, lines])

  // `rows` keeps the original auto-grow behaviour: as tall as its content
  // (minimum six rows), scrolling only once the user has dragged it smaller.
  // The line count is already known when highlighting, so the string is split
  // once per keystroke rather than twice.
  const rows = Math.max(6, (lines ? lines.length : value.split('\n').length) + 1)

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value)
    },
    [onChange],
  )

  /**
   * Keep the underlay's scroll offset and content width equal to the
   * textarea's.
   *
   * Imperative rather than through React state on purpose: a scroll that went
   * through a state update would paint the underlay a frame behind the caret,
   * which is the single most visible way this technique fails.
   *
   * The WIDTH is the scrollbar. A textarea that is scrolling loses its
   * scrollbar's width from its content box, so it wraps earlier than a `<pre>`
   * of the same outer width — and every wrapped line after the first then sits
   * on a different row in the two layers. `scrollbar-gutter: stable` fixes that
   * in Chrome and Firefox but is not universal, so the width is measured and
   * applied too, which is exact everywhere. An explicit `width` over-constrains
   * the absolutely-positioned underlay, and width wins over `right`, which is
   * the intent.
   */
  const syncGeometry = useCallback(() => {
    const textarea = textareaRef.current
    const underlay = underlayRef.current
    if (!textarea || !underlay) {
      return
    }
    if (textarea.clientWidth > 0) {
      underlay.style.width = `${textarea.clientWidth}px`
    }
    underlay.scrollTop = textarea.scrollTop
    underlay.scrollLeft = textarea.scrollLeft
  }, [])

  // A LAYOUT effect, not a passive one: the width is what makes the two layers
  // wrap identically, so it has to be applied before the browser paints. A
  // passive effect would show one frame at the wrong width on every mount and
  // on every toggle of the preference.
  //
  // The observer is created once per mount (per `highlight` state), not per
  // keystroke: `rows` grows with the content, so a new line resizes the
  // textarea and the observer fires on its own.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!highlight || !textarea) {
      return
    }
    syncGeometry()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => syncGeometry())
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [highlight, syncGeometry])

  // THERE IS DELIBERATELY NO value-driven sync here.
  //
  // One existed, to catch the browser clamping `scrollTop` when the content
  // shrinks. It cost a FORCED SYNCHRONOUS LAYOUT of the whole underlay on every
  // keystroke — `clientWidth` and `scrollTop` are both layout reads, taken
  // immediately after React had mutated the text — and on a 600-line source
  // that layout is 2 100 spans' worth. Measured in headless Chrome it was the
  // dominant per-keystroke cost, far larger than tokenising.
  //
  // It was also redundant. A clamp CHANGES the scroll position, and changing
  // the scroll position fires `scroll`, which `onScroll` already handles; and a
  // size change is what the ResizeObserver above is for. Between them every
  // case the value-driven sync covered is still covered, without reading layout
  // on the typing path.

  return (
    <div
      className={'MermaidCode bg-default relative min-w-0' + (highlight ? ' MermaidCode--highlighted' : '')}
      {...{ [MERMAID_CODE_PANE_ATTRIBUTE]: 'true' }}
    >
      {highlight && children ? (
        <pre
          ref={underlayRef}
          aria-hidden="true"
          className={`MermaidCode__underlay ${MERMAID_CODE_LAYER_CLASS}`}
          style={paletteStyle}
          {...{ [MERMAID_CODE_UNDERLAY_ATTRIBUTE]: 'true' }}
        >
          {/* One block element per line, reused by identity when that line is
              unchanged. See the cache above, and MermaidCodeLine for why the
              structure is blocks rather than one flow with newlines in it. */}
          {children}
        </pre>
      ) : null}
      <textarea
        ref={textareaRef}
        className={
          'MermaidCode__input text-foreground w-full resize-y outline-none ' +
          MERMAID_CODE_LAYER_CLASS +
          (highlight ? ' MermaidCode__input--highlighted' : '')
        }
        rows={rows}
        value={value}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        onChange={handleChange}
        onScroll={syncGeometry}
        placeholder={placeholder}
        aria-label={ariaLabel}
        {...{ [MERMAID_CODE_INPUT_ATTRIBUTE]: 'true' }}
      />
    </div>
  )
}
