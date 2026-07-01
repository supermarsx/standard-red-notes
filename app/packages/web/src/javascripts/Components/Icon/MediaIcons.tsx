import { SVGProps } from 'react'

/**
 * Local media-transport + AI glyphs. The shared @standardnotes/icons set has no
 * play/pause/stop/sparkle, so these are defined here and registered as Lexical
 * icon names. They inherit `fill-current` from the Icon wrapper.
 */

export const PlayIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M8 5v14l11-7z" />
  </svg>
)

export const PauseIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
  </svg>
)

export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
)

export const SparkleIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M12 2l1.6 5.1a4 4 0 0 0 2.6 2.6L21.4 11l-5.2 1.6a4 4 0 0 0-2.6 2.6L12 20.4l-1.6-5.2a4 4 0 0 0-2.6-2.6L2.6 11l5.2-1.6a4 4 0 0 0 2.6-2.6z" />
    <path d="M19 3l.6 1.8L21.4 5.4l-1.8.6L19 7.8l-.6-1.8L16.6 5.4l1.8-.6z" />
  </svg>
)

export const MicIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
    <path d="M19 11a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V23h2v-3.06A9 9 0 0 0 21 11h-2z" />
  </svg>
)

/**
 * Calendar glyph for the Super-editor Calendar block. The shared
 * @standardnotes/icons set has no calendar, so it lives here. A framed month
 * grid with two hanging rings — clearly a calendar at the visual weight of the
 * neighboring block icons.
 */
export const CalendarIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zM4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9H4zm16-2H4V7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v1z"
    />
    <path d="M7 13h3v3H7v-3z" />
  </svg>
)

/**
 * Highlighter / marker pen glyph for the Super-editor "Highlight color" toolbar
 * button. The shared @standardnotes/icons set has no highlighter, so it lives
 * here. A chisel-tip marker drawn on a diagonal, with a wide nib and a short
 * stroke of laid-down ink beneath it — clearly reads as a highlighter and is
 * visually distinct from the plain "A" used for the (text) Font color button.
 */
export const HighlighterIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M15.6 3.3a2 2 0 0 1 2.83 0l2.27 2.27a2 2 0 0 1 0 2.83l-8.04 8.04-5.1-5.1L15.6 3.3z" />
    <path d="M6.86 12.05l5.09 5.09-1.2 1.2a1.5 1.5 0 0 1-1.06.44H7.3l-1.2 1.2a1 1 0 0 1-1.41 0l-1.42-1.42a1 1 0 0 1 0-1.41l1.2-1.2v-2.38a1.5 1.5 0 0 1 .44-1.06l1.95-1.96z" />
    <path d="M3 22h7a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2z" />
  </svg>
)

/**
 * Word-spacing glyph for the Super-editor "Word spacing" toolbar button. Reads as
 * two solid word/letter blocks separated by a horizontal gap with inward-pointing
 * arrows along a baseline — i.e. the adjustable space *between words*. Deliberately
 * distinct from the letter-spacing/kerning control (which uses the thin `line-width`
 * rule glyph): this one shows whole word blocks with a gap, not individual letters.
 */
export const WordSpacingIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    {/* Left word block */}
    <rect x="2" y="6" width="6.5" height="9" rx="1" />
    {/* Right word block */}
    <rect x="15.5" y="6" width="6.5" height="9" rx="1" />
    {/* Baseline under both words */}
    <path d="M2 19.5h20a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2z" />
    {/* Gap arrows pointing outward to mark the space between the two words */}
    <path d="M10 7.5l-2.4 3 2.4 3v-2h4v2l2.4-3-2.4-3v2h-4v-2z" />
  </svg>
)

/**
 * "Select all text" glyph for the Super-editor Selection group. Reads as the
 * dashed marquee selection box (like the plain select-all icon) but with text
 * lines drawn inside it, signalling that only the TEXT content is selected (not
 * embedded/decorator blocks). Deliberately distinct from the shared `select-all`
 * icon, which shows an empty selection frame.
 */
export const SelectAllTextIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    {/* Dashed marquee corners (selection frame) */}
    <path d="M3 3h4v2H5v2H3V3zm14 0h4v4h-2V5h-2V3zM3 17h2v2h2v2H3v-4zm16 0h2v4h-4v-2h2v-2z" />
    {/* Text lines inside the frame, indicating text-only selection */}
    <path d="M8 8h8v2H8V8zm0 3.5h8v2H8v-2zM8 15h5v2H8v-2z" />
  </svg>
)

/**
 * Emphasis-marks glyph for the Super-editor "Emphasis marks" toolbar button. The
 * `text-emphasis` CSS feature places a small mark (CJK-style "boutened" dot) over
 * each glyph for emphasis — so the icon is a solid letter "A" with a single filled
 * dot floating above it. Deliberately distinct from Bold/Italic/Underline (which
 * style the letter itself) and from the `sparkle` decoration formerly used here:
 * the lone dot-over-letter unambiguously reads as an emphasis mark.
 */
export const EmphasisMarksIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    {/* Emphasis dot centered above the letter */}
    <circle cx="12" cy="4" r="2" />
    {/* Letter "A" beneath the dot */}
    <path d="M12 8.5l5 11h-2.25l-1.1-2.6H10.35l-1.1 2.6H7l5-11zm0 4.1l-1.55 3.7h3.1L12 12.6z" />
  </svg>
)

/**
 * Inline-code glyph for the Super-editor "Inline Code" toolbar button. The classic
 * `</>` mark (two angle brackets straddling a forward slash) reads unambiguously as
 * code. Distinct from the Code *Block* button: this is the compact slash-and-chevrons
 * inline mark, replacing the prior bare `< >` (code-tags) glyph which lacked the slash.
 */
export const InlineCodeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...props}>
    {/* Left chevron "<" */}
    <path d="M8.5 7.4L3.9 12l4.6 4.6 1.5-1.5L6.9 12l3.1-3.1L8.5 7.4z" />
    {/* Right chevron ">" */}
    <path d="M15.5 7.4l-1.5 1.5L17.1 12l-3.1 3.1 1.5 1.5L20.1 12 15.5 7.4z" />
    {/* Forward slash "/" through the middle */}
    <path d="M13.4 5.2l-1.9-.6-3 14.2 1.9.6 3-14.2z" />
  </svg>
)

/**
 * Outline / text-stroke glyph for the Super-editor "Outline (text stroke)" toolbar
 * button. A HOLLOW (stroked, not filled) letter "A" — conveying outlined / stroked
 * text. Drawn with an explicit `fill="none"` + `stroke="currentColor"` so it stays
 * hollow even though the Icon wrapper adds `fill-current`. Deliberately distinct
 * from the SOLID "A" used for the Text color button.
 */
export const OutlineTextIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path
      d="M5 19L12 4l7 15M8 14h8"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
