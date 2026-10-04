import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { clampPanelWidth } from '../../Components/PanelResizer/PanelResizer'
import { NAVIGATION_MINI_RAIL_WIDTH } from '../../Components/Tags/navigationMini'
import { dockAssistantPaneToRight } from './assistantPaneLayout'

/**
 * Standard Red Notes: the sidebars' remembered STATE, and their current STATUS.
 *
 * The ask was to "memorize states of sidebars per user and their status as
 * well", and those are two different questions:
 *
 *   STATE is what the user chose, and it is what gets persisted: which of
 *   collapsed / mini / expanded each sidebar is in, plus the width it was
 *   dragged to. Device-local for the shape of the layout
 *   (`LocalPrefKey.NavigationPaneCollapsed`, `LocalPrefKey.NavigationPaneMini`,
 *   `LocalPrefKey.ListPaneCollapsed`), per-account for the widths
 *   (`PrefKey.TagsPanelWidth`, `PrefKey.NotesPanelWidth`). A state is a REQUEST,
 *   carried across reloads.
 *
 *   STATUS is whether that request can be honoured on this screen right now, and
 *   it is not the user's choice at all: the tablet breakpoint removes the
 *   Navigation pane from the pane stack entirely, mini is suppressed below the
 *   desktop breakpoint (`Navigation.tsx`: a 48px rail inside a full-width tablet
 *   pane is a strip of glyphs), and focus mode drives both sidebar columns to a
 *   literal `0` while leaving the panes in the stack.
 *
 * The two are deliberately asymmetric: **the state decides, the status vetoes.**
 * Nothing in this module ever ADDS a pane the environment removed, and nothing
 * claims "mini" on a screen whose renderer draws the full labelled column —
 * either would be a displayed value claiming more than its source establishes.
 *
 * Why the state lives here and not inline in `PaneController.handleEvent`: the
 * launch restore used to be a four-branch `if` inside an event handler on a
 * controller whose constructor needs mobx plus half a dozen services, which is
 * why the sibling spec resorted to re-typing method bodies "verbatim". As pure
 * functions the real launch decision is directly testable, including the two
 * cases it previously had no way to express: mini, and a screen that cannot show
 * it.
 */

export enum SidebarPaneState {
  /** Not in the pane stack at all — the explicit collapse the user asked for. */
  Collapsed = 'collapsed',
  /**
   * In the stack, rendered as the narrow icon rail. Navigation only: a 48px
   * column of note titles would show no titles, so the notes list has no rail
   * and `listPaneStateFrom` never returns this.
   */
  Mini = 'mini',
  /** In the stack, rendered as the full labelled column. */
  Expanded = 'expanded',
}

/**
 * Why these take `unknown` rather than `boolean`.
 *
 * A local preference is whatever was last written into encrypted device storage,
 * including by an older build, and `LocalPrefDefaults` is read out of a
 * generated bundle that can predate a newly added key — so a read can yield
 * `undefined`, or a legacy `'true'` string, with nothing in the type system
 * saying so. Only the literal `true` turns a pane state on. This is the same
 * rule the assistant pane's persistence follows (`isAssistantPanePersistedOpen`)
 * and its spec pins the `'true'` case for exactly this reason.
 */
export const navigationPaneStateFrom = ({
  collapsedPreference,
  miniPreference,
  isTabletOrMobile,
}: {
  collapsedPreference: unknown
  miniPreference: unknown
  isTabletOrMobile: boolean
}): SidebarPaneState => {
  // Collapsed wins over mini, in both directions of the comparison: a pane the
  // user explicitly removed must not come back as a rail, and turning mini on
  // must not be a second way to reopen a pane. The two preferences stay
  // independent so that collapsing a rail and expanding it again returns the
  // rail rather than the full column.
  if (collapsedPreference === true) {
    return SidebarPaneState.Collapsed
  }

  // The status veto. `Navigation.tsx` renders the full labelled column whenever
  // `isTabletOrMobile`, so reporting Mini here would make the controller
  // disagree with what is actually on screen.
  if (miniPreference === true && !isTabletOrMobile) {
    return SidebarPaneState.Mini
  }

  return SidebarPaneState.Expanded
}

export const listPaneStateFrom = ({ collapsedPreference }: { collapsedPreference: unknown }): SidebarPaneState => {
  return collapsedPreference === true ? SidebarPaneState.Collapsed : SidebarPaneState.Expanded
}

/** Whether a pane in this state belongs in the pane stack at all. */
export const isSidebarPanePresent = (state: SidebarPaneState): boolean => state !== SidebarPaneState.Collapsed

/**
 * The launch layout: which panes exist when the app has just finished reading
 * the persisted state.
 *
 * Mini and expanded produce the same pane STACK by design — a rail is a visible
 * Navigation pane, not a third kind of pane — so the difference between them is
 * the width of its column and what renders inside it, never whether it is there.
 * What mini adds to this decision is the guarantee that it cannot change the
 * answer: `isSidebarPanePresent` is what the stack is built from, so a mini
 * preference can neither resurrect a collapsed pane nor remove a present one.
 */
export const launchPanes = ({
  isTabletOrMobile,
  navigationPaneState,
  listPaneState,
  restoreAssistant,
}: {
  isTabletOrMobile: boolean
  navigationPaneState: SidebarPaneState
  listPaneState: SidebarPaneState
  restoreAssistant: boolean
}): AppPaneId[] => {
  // Tablet and mobile use a navigation STACK rather than columns: Navigation and
  // Items are both pushed and one is shown at a time, so neither collapse
  // preference applies and this branch is unchanged by the three-state model.
  const panes: AppPaneId[] = isTabletOrMobile
    ? [AppPaneId.Navigation, AppPaneId.Items]
    : [
        ...(isSidebarPanePresent(navigationPaneState) ? [AppPaneId.Navigation] : []),
        ...(isSidebarPanePresent(listPaneState) ? [AppPaneId.Items] : []),
        AppPaneId.Editor,
      ]

  if (!restoreAssistant) {
    return panes
  }

  return isTabletOrMobile
    ? [...panes.filter((pane) => pane !== AppPaneId.Assistant), AppPaneId.Assistant]
    : dockAssistantPaneToRight(panes, true)
}

/**
 * Whether a sidebar is actually on screen right now, and if not, why not.
 *
 * This is the status half, and it exists because "in the pane stack" and
 * "visible" came apart: focus mode leaves both sidebars in `panes` and sets
 * their grid columns — and then `width: 0px !important` in `_focused.scss` — to
 * zero. A control that reads only the stack therefore describes a pane the user
 * cannot see as expanded, and acting on it rewrites a remembered state with no
 * observable effect.
 */
export enum SidebarPaneStatus {
  /** In the stack and rendered at its own width. */
  Visible = 'visible',
  /** The user's remembered choice: absent from the stack. */
  Collapsed = 'collapsed',
  /** In the stack, but the layout gives it a zero-width column. */
  HiddenByFocusMode = 'hidden-by-focus-mode',
}

/**
 * Focus mode is checked FIRST, so a pane that is both collapsed and focus-hidden
 * reports focus mode. The question this answers is "why can the user not see it,
 * and can they do anything about it now" — and under focus mode the answer is
 * the same for both sidebars no matter what their remembered state says.
 */
export const sidebarPaneStatus = ({
  present,
  focusModeEnabled,
}: {
  present: boolean
  focusModeEnabled: boolean
}): SidebarPaneStatus => {
  if (focusModeEnabled) {
    return SidebarPaneStatus.HiddenByFocusMode
  }

  return present ? SidebarPaneStatus.Visible : SidebarPaneStatus.Collapsed
}

/**
 * The pane minimums, mirrored from `PanesSystemComponent`'s module-private
 * constants of the same names (they are not exported, and that file belongs to
 * another change in flight). `sidebarPaneState.spec.ts` reads that file and
 * fails if either number drifts away from this one.
 *
 * The navigation minimum is not a second literal: it IS the mini rail width,
 * which is what that minimum has always been, so both files source it from
 * `navigationMini`.
 */
export const NAVIGATION_PANEL_MIN_WIDTH = NAVIGATION_MINI_RAIL_WIDTH
export const ITEMS_PANEL_MIN_WIDTH = 200

/**
 * A persisted sidebar width, re-validated on READ.
 *
 * Nothing re-clamped a restored width: `resizeFinishCallback` persists whatever
 * the resizer last held, focus mode drives these columns to `0`, and a legacy or
 * corrupted preference can hold anything at all — and the restore then handed
 * that straight back as the pane's width. A width that is not a usable number
 * falls back to the pane's DEFAULT rather than its minimum, because "never
 * configured" and "dragged as narrow as it goes" are different facts and must
 * not render identically. Shares `clampPanelWidth` with the pane system so there
 * is one rule rather than two.
 */
export const restoredNavigationPanelWidth = (width: number | undefined | null, fallbackWidth: number): number =>
  clampPanelWidth(width, NAVIGATION_PANEL_MIN_WIDTH, fallbackWidth)

/** As above, for the notes list. */
export const restoredItemsPanelWidth = (width: number | undefined | null, fallbackWidth: number): number =>
  clampPanelWidth(width, ITEMS_PANEL_MIN_WIDTH, fallbackWidth)
