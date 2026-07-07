/**
 * Standard Red Notes: Typography Profiles (Phase 1 — data model).
 *
 * A typography profile is a per-account, synced bundle of per-block-type visual
 * styles for the Super (Lexical) editor. Exactly one profile is "active" at a
 * time (selected via `PrefKey.ActiveTypographyProfileId`); the full set lives in
 * `PrefKey.TypographyProfiles`. The active profile is compiled to a single
 * scoped `<style>` element by the web app (see `Utils/typographyProfiles.ts`),
 * so it applies uniformly to the editor, the read-only viewer and previews with
 * no per-note mutation.
 *
 * These are plain data types (no runtime logic) so they can live in the synced
 * preferences blob and be referenced from `PrefDefaults`.
 */

/**
 * The block types a profile can style. Each maps 1:1 to a Lexical theme class
 * (or, for callouts, a data-attribute) that the web-side compiler targets.
 */
export type BlockTypeKey =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'code'
  | 'callout'
  | 'bulletList'
  | 'numberedList'
  | 'checkList'

/** Which edge(s) a block's border declarations apply to. */
export type BlockBorderSide = 'all' | 'left' | 'right' | 'top' | 'bottom'

/**
 * A flat, fully-optional bag of curated CSS-ish properties for a single block
 * type. Property names are chosen to map 1:1 onto the CSS declarations that the
 * toolbar's block formatting (#77) already writes as inline styles, plus the
 * curated typography / colour / box / list controls. Every value is a string in
 * the same grammar the corresponding CSS declaration accepts.
 *
 * IMPORTANT: because #77 writes the block-spacing/indent properties as *inline*
 * styles, and inline styles outrank any selector-based rule, a profile's value
 * for those same properties is the DEFAULT for blocks the user has not manually
 * adjusted — a per-block manual override always wins by the cascade.
 */
export type BlockStyle = {
  // --- Block spacing / indentation (mirror blockFormatting.ts declarations) ---
  /** line-height (unit-less multiplier or CSS length). */
  lineHeight?: string
  /** margin-top ("space before"). */
  marginTop?: string
  /** margin-bottom ("space after"). */
  marginBottom?: string
  /** margin-left. */
  marginLeft?: string
  /** margin-right. */
  marginRight?: string
  /** padding-left (left indent). */
  paddingLeft?: string
  /** padding-right (right indent). */
  paddingRight?: string
  /** text-indent (first-line indent). */
  textIndent?: string

  // --- Typography ---
  /**
   * font-family, in the SAME grammar as `PrefKey.EditorFontFamily`:
   *   ''                     -> inherit (no override)
   *   'google:<Family>'      -> a Google Font (loaded via the vetted font path)
   *   any other string       -> a literal CSS font-family stack / local font
   */
  fontFamily?: string
  /** font-size. */
  fontSize?: string
  /** font-weight. */
  fontWeight?: string
  /** font-style. */
  fontStyle?: string
  /** letter-spacing. */
  letterSpacing?: string
  /** text-transform. */
  textTransform?: string

  // --- Colour ---
  /** color (foreground). */
  color?: string
  /** background-color. */
  backgroundColor?: string

  // --- Alignment ---
  /** text-align. */
  textAlign?: string

  // --- Box (quote / callout / code) ---
  /** border colour. */
  borderColor?: string
  /** border width. */
  borderWidth?: string
  /** border style (solid / dashed / …). */
  borderStyle?: string
  /** which edge(s) the border applies to (default 'all'). */
  borderSide?: BlockBorderSide
  /** border-radius. */
  borderRadius?: string
  /** padding-block (vertical padding). */
  paddingBlock?: string

  // --- Lists ---
  /** list-style-type (disc / decimal / …). */
  listMarkerStyle?: string
  /** ::marker colour. */
  markerColor?: string
}

/**
 * A named, per-account typography profile. `blocks` is a sparse map: a block
 * type absent from the map (or mapped to an empty `BlockStyle`) contributes no
 * CSS and therefore leaves that block's built-in theme appearance untouched.
 */
export type TypographyProfile = {
  /** Stable identifier, referenced by `ActiveTypographyProfileId`. */
  id: string
  /** User-facing display name. */
  name: string
  /** True for the built-in Default profile (not user-deletable). */
  isDefault: boolean
  /** Schema version for forward-compatible migrations. */
  schemaVersion: number
  /** Per-block styles. */
  blocks: Partial<Record<BlockTypeKey, BlockStyle>>
}

/** Current typography-profile schema version. */
export const TYPOGRAPHY_PROFILE_SCHEMA_VERSION = 1

/** Stable id of the built-in Default profile. */
export const DEFAULT_TYPOGRAPHY_PROFILE_ID = 'default'

/**
 * The built-in Default profile. Its per-block styles reproduce the CURRENT
 * appearance defined in `SuperEditor/Lexical/Theme/editor.scss`, so that when it
 * is the active profile the generated CSS is equivalent to the existing theme
 * and EXISTING NOTES LOOK UNCHANGED.
 *
 * Only the properties the theme actually sets are listed (matched to the exact
 * values in editor.scss). Block types whose appearance is variant-driven
 * (callout) or purely inherited (lists) are intentionally left empty so the
 * Default profile never overrides them.
 */
export const DEFAULT_TYPOGRAPHY_PROFILE: TypographyProfile = {
  id: DEFAULT_TYPOGRAPHY_PROFILE_ID,
  name: 'Default',
  isDefault: true,
  schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  blocks: {
    // .Lexical__paragraph { margin: 0 }
    paragraph: {
      marginTop: '0',
      marginBottom: '0',
    },
    // .Lexical__h1 { font-size: 1.625rem; font-weight: 700; color: editor-fg; margin: 0 }
    h1: {
      fontSize: '1.625rem',
      fontWeight: '700',
      color: 'var(--sn-stylekit-editor-foreground-color)',
      marginTop: '0',
      marginBottom: '0',
    },
    // .Lexical__h2 { font-size: 1.375rem; font-weight: 700; color: editor-fg; margin: 0 }
    h2: {
      fontSize: '1.375rem',
      fontWeight: '700',
      color: 'var(--sn-stylekit-editor-foreground-color)',
      marginTop: '0',
      marginBottom: '0',
    },
    // .Lexical__h3 { font-size: 1.1875rem; font-weight: 700; margin: 0 } (no colour)
    h3: {
      fontSize: '1.1875rem',
      fontWeight: '700',
      marginTop: '0',
      marginBottom: '0',
    },
    // .Lexical__quote { margin:0 0 10px 20px; color: passive-1; border-left: 4px solid passive-1; padding-left: 16px }
    quote: {
      marginTop: '0',
      marginBottom: '10px',
      marginLeft: '20px',
      color: 'var(--sn-stylekit-passive-color-1)',
      borderSide: 'left',
      borderColor: 'var(--sn-stylekit-passive-color-1)',
      borderWidth: '4px',
      borderStyle: 'solid',
      paddingLeft: '16px',
    },
    // .Lexical__code { background: contrast-bg; margin: 0.5rem 0; padding: 1.25rem 1.35rem; border-radius: 0.25rem }
    code: {
      backgroundColor: 'var(--sn-stylekit-contrast-background-color)',
      marginTop: '0.5rem',
      marginBottom: '0.5rem',
      paddingBlock: '1.25rem',
      paddingLeft: '1.35rem',
      paddingRight: '1.35rem',
      borderRadius: '0.25rem',
    },
  },
}
