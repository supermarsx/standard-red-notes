import { createContext, useContext } from 'react'
import { classNames } from '@standardnotes/utils'
import type { LocalPrefKey } from '@standardnotes/snjs'

/**
 * Standard Red Notes: the sidebar's "mini" mode — a narrow icon rail instead of
 * the full icon + label column.
 *
 * WHY A PREFERENCE AND NOT A ROLE GATE. The ask was for the sidebar to be able
 * to "be mini, like little icons, for certain types of users". Role-gating it
 * (the pattern `featuresController.isAdminUser()` uses for the Admin pane) was
 * rejected deliberately: roles are a *server claim* — unavailable offline and
 * re-written by `ApplicationEvent.UserRolesChanged`. A layout mode that silently
 * vanished whenever that claim could not be fetched would be claiming more than
 * its source establishes. So "certain types of users" is expressed the way this
 * app already expresses every other per-person layout choice: one device-local,
 * encrypted preference, default OFF.
 *
 * WHAT MINI MEANS, EXACTLY. Every entry keeps its `<Icon>` and drops its visible
 * `<span>` label — but the label is NOT discarded: it moves into `title` and
 * `aria-label` so it stays in the accessibility tree and in the tooltip. That is
 * the same reasoning as the checklist due control (`ChecklistDueControls.ts`):
 * taking something out of the *visual* layout must not take it out of the
 * accessible name. An entry with no label to move keeps no empty `title` either
 * — an empty accessible name is a claim of its own.
 *
 * WHAT MINI DOES NOT DO. It does not set a width on anything. The rail width
 * below is exported for the pane system to apply as the Navigation column /
 * resizer width, which is what keeps mini compatible with the two mechanisms
 * that already own that column:
 *
 *  - the tablet-responsive rule, which *removes* the Navigation pane from the
 *    pane stack entirely. Mini is a rendering mode inside the pane, so it has
 *    no opinion about whether the pane exists; nothing resurrects it. And mini
 *    is suppressed below the desktop breakpoint anyway (see `Navigation.tsx`),
 *    because a tablet/mobile Navigation pane is presented full-width, where an
 *    icon rail would be a 48px strip of glyphs in a 100%-wide column.
 *  - focus mode, which sets the Navigation grid column to a literal `0`. Since
 *    mini never writes a width, min-width or flex-basis of its own, a focus-mode
 *    column of 0 still collapses the rail exactly as it collapses the full
 *    column.
 */

/**
 * Width of the icon rail, in px. This is deliberately the same 48 as the pane
 * system's existing `NAVIGATION_PANEL_MIN_WIDTH`: that minimum already permitted
 * a 48px Navigation column, there was simply never anything rendered for it.
 * Exported so the pane system has one source for the number rather than a second
 * literal that can drift away from this one.
 */
export const NAVIGATION_MINI_RAIL_WIDTH = 48

/**
 * The local preference key, pinned as a string rather than read off the
 * `LocalPrefKey` enum object.
 *
 * Web consumes the enum's RUNTIME value from `packages/snjs/dist/snjs.js` — the
 * artifact both webpack and jest resolve `@standardnotes/snjs` to — and a newly
 * added member is absent there until that shared bundle is rebuilt. Reading
 * `LocalPrefKey.NavigationPaneMini` today yields `undefined`, which would store
 * the preference under the key `"undefined"` and make the toggle look inert. A
 * string enum is its own string at runtime, so this literal IS that member while
 * depending on nothing generated; the cast is type-only, so the declaration in
 * `LocalPrefKey.ts` still types every read and write. Swap it for the plain
 * member once snjs has been rebuilt in a normal build cycle.
 *
 * The same staleness is why every read of this preference compares against
 * `true` rather than trusting it to be a boolean: `LocalPrefDefaults` in that
 * bundle has no entry for the key either, so the default arrives as `undefined`
 * — which must mean OFF, not "missing".
 */
export const NAVIGATION_PANE_MINI_PREF_KEY = 'navigationPaneMini' as LocalPrefKey.NavigationPaneMini

/**
 * Class and data attribute put on the Navigation root in mini mode. The class is
 * the hook the stylesheet needs for the parts of the rail that are purely
 * cosmetic (centring a lone glyph, hiding section titles); the data attribute is
 * the assertable half, because jsdom has no layout engine and no stylesheet.
 */
export const NAVIGATION_MINI_CONTAINER_CLASS = 'navigation-mini'
export const NAVIGATION_MINI_DATA_ATTR = 'data-navigation-mini'

/**
 * Sub-tags still nest in mini mode, so a child must not render flush with its
 * parent and claim to be a root. A 48px rail cannot afford the full column's
 * 21px-per-level step, so mini uses a token step with a low ceiling: enough to
 * read "this one is under that one", never enough to push the glyph off the rail.
 */
export const NAVIGATION_MINI_INDENT_PER_LEVEL_PX = 4
export const NAVIGATION_MINI_MAX_INDENT_LEVELS = 3

export const navigationMiniIndentPx = (level: number): number =>
  Math.min(Math.max(level, 0), NAVIGATION_MINI_MAX_INDENT_LEVELS) * NAVIGATION_MINI_INDENT_PER_LEVEL_PX

/**
 * Whether the sidebar is currently rendering as an icon rail. Read by the
 * individual entries so each one does not have to re-read the preference (and so
 * none of them can disagree with the container about which mode is active).
 * Defaults to `false`, which is both the preference default and the correct
 * answer for any entry rendered outside the sidebar.
 */
export const NavigationMiniContext = createContext(false)

export const useNavigationMini = (): boolean => useContext(NavigationMiniContext)

/** `title` + `aria-label`, or neither. Never an empty one of either. */
export type NavigationEntryLabelProps = {
  title?: string
  'aria-label'?: string
}

export type NavigationEntryProjection = {
  /** Full class list for the entry's `<button>`. */
  className: string
  /** Where the label lives when it is not rendered as text. */
  labelProps: NavigationEntryLabelProps
  /** Whether the visible `<span>` label renders. */
  showLabel: boolean
  /** Class list for that `<span>` when it does. */
  labelClassName: string
}

/**
 * The full-column class list, unchanged from what every sidebar entry shipped
 * before mini mode existed, so turning mini off is byte-for-byte the old entry.
 */
const ENTRY_FULL_CLASS = 'flex w-full items-center gap-3 px-3.5 py-2 text-left text-base lg:text-sm'

/**
 * The rail class list: no `gap-3` (there is nothing to sit beside the glyph) and
 * no `px-3.5` (14px a side would leave 20px for a 20px glyph), with the glyph
 * centred instead of leading.
 */
const ENTRY_MINI_CLASS = 'flex w-full items-center justify-center px-0 py-2 text-left text-base lg:text-sm'

const ENTRY_INTERACTION_CLASS = 'hover:bg-contrast focus:bg-contrast focus:shadow-none focus:outline-none'

const accessibleNameFor = (label: string, accessibleLabel?: string): string => (accessibleLabel ?? label).trim()

/**
 * Project one of the sidebar's fixed section entries for the current mode.
 *
 * @param label the entry's visible text, and its accessible name by default.
 * @param accessibleLabel a richer accessible name for entries carrying state the
 *   visible label does not spell out (the notifications count, for instance).
 *   Used only where the visible label is gone, since otherwise the rendered text
 *   is already the accessible name.
 */
export const navigationEntryProjection = ({
  mini,
  isActive,
  label,
  accessibleLabel,
}: {
  mini: boolean
  isActive: boolean
  label: string
  accessibleLabel?: string
}): NavigationEntryProjection => {
  const accessibleName = accessibleNameFor(label, accessibleLabel)

  return {
    className: classNames(
      mini ? ENTRY_MINI_CLASS : ENTRY_FULL_CLASS,
      ENTRY_INTERACTION_CLASS,
      isActive && 'bg-contrast',
    ),
    // In the full column the rendered text IS the accessible name, so adding a
    // second copy as `aria-label` would only create a way for the two to drift.
    labelProps: mini && accessibleName.length > 0 ? { title: accessibleName, 'aria-label': accessibleName } : {},
    showLabel: !mini,
    labelClassName: classNames('flex-grow truncate font-semibold', isActive && 'text-info'),
  }
}

export type NavigationTagRowProjection = {
  /** Horizontal padding utilities for the row, which differ per mode. */
  paddingClassName: string
  /** Inline indent for the row's nesting level. */
  style: { paddingLeft: string }
  /** Where the row's title lives when it is not rendered as text. */
  labelProps: NavigationEntryLabelProps
  /** Whether the title element renders. */
  showTitle: boolean
  /** Whether the note-count element renders. */
  showCount: boolean
  /** Whether the row's context-menu affordance renders. */
  showMenu: boolean
  /**
   * Whether a state marker (the hidden-row glyph) renders beside the row's own
   * icon. On the rail there is no room for a second glyph, so the state has to
   * reach the reader through the accessible name and the row's dimming instead
   * — see `accessibleLabel`.
   */
  showHiddenMarker: boolean
}

/**
 * Project a smart-view / tag row for the current mode.
 *
 * The count and the context-menu affordance are dropped in mini rather than
 * shrunk: both are text-ish controls that cannot be read at rail width, and a
 * truncated count ("1…") would be a wrong number rather than a missing one. The
 * expand/collapse chevron is deliberately KEPT, because dropping it would make
 * a collapsed sub-tree unreachable without leaving mini mode.
 *
 * @param indentPx the row's full-column indent, already computed by the caller
 *   (each list owns its own base padding and per-level step).
 * @param accessibleLabel a richer accessible name for a row carrying state that
 *   the rail cannot show as a second glyph (a hidden row, for instance). Used
 *   only where the visible title is gone, since otherwise the marker is right
 *   there to be read.
 */
export const navigationTagRowProjection = ({
  mini,
  level,
  indentPx,
  label,
  accessibleLabel,
}: {
  mini: boolean
  level: number
  indentPx: number
  label: string
  accessibleLabel?: string
}): NavigationTagRowProjection => {
  const accessibleName = accessibleNameFor(label, accessibleLabel)

  return {
    paddingClassName: mini ? 'px-0' : 'px-3.5',
    style: { paddingLeft: `${mini ? navigationMiniIndentPx(level) : indentPx}px` },
    labelProps: mini && accessibleName.length > 0 ? { title: accessibleName, 'aria-label': accessibleName } : {},
    showTitle: !mini,
    showCount: !mini,
    showMenu: !mini,
    showHiddenMarker: !mini,
  }
}
