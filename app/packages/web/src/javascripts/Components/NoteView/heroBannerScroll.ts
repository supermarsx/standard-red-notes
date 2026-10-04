/**
 * Standard Red Notes: when the note's cover banner (HeroHeaderBanner) is allowed
 * to occupy space.
 *
 * The banner sits ABOVE the note's scroll container, so it never scrolls away on
 * its own and permanently costs the writing area its height. The rule is: it is
 * visible only while the reader is at the absolute top of the document, and it
 * goes away the moment they scroll at all.
 *
 * The one subtlety is the boundary. Hiding the banner hands its height back to
 * the scroll container, which makes the container's scroll range *shorter*. For
 * a note only slightly taller than the viewport, that is enough to make the
 * content unscrollable again — the browser then clamps scrollTop back to 0, the
 * banner returns, and the next wheel tick repeats the whole cycle. The banner
 * would flicker on every scroll attempt, which is worse than either state.
 *
 * So the hide is gated on the scroller having more scroll range to give than the
 * banner is worth. When it does, hiding is a pure win and the banner stays gone
 * until the reader returns to the top. When it does not — a short note, where
 * the banner is most of the reason the note scrolls at all — the banner simply
 * stays put rather than blinking.
 */

/**
 * Height of the no-cover "Add cover" affordance, measured at 25px against the
 * built stylesheet (px-2 py-1 around a 0.875rem icon and text-xs). Used only as
 * a fallback when the banner's own `offsetHeight` is not available yet — the
 * first frame after mount, and any environment without layout.
 *
 * Standard Red Notes (t111): the hidden-cover notice rendered when covers are
 * switched off is the same shape — one line of `text-xs` with `py-1` padding —
 * so it shares this fallback. That is why `NoteView.heroBannerHeight()` returns
 * this value, and NOT the preserved `heroHeader.height`, whenever covers are
 * off: the stored height describes a banner that is not on screen.
 */
export const HERO_AFFORDANCE_HEIGHT = 26

export type HeroBannerScrollState = {
  /** Current scroll offset of the note's scroll container. */
  scrollTop: number
  /** Full scrollable height of that container. */
  scrollHeight: number
  /** Visible height of that container. */
  clientHeight: number
  /** Rendered height of the banner, or 0 when it is already hidden. */
  bannerHeight: number
  /** Whether the banner is occupying space right now. */
  currentlyVisible: boolean
}

/**
 * Whether the cover banner should be rendered after a scroll event. Pure, so the
 * boundary behaviour is testable without a layout engine.
 */
export function shouldShowHeroBanner({
  scrollTop,
  scrollHeight,
  clientHeight,
  bannerHeight,
  currentlyVisible,
}: HeroBannerScrollState): boolean {
  // At (or above, on an elastic/overscrolling platform) the absolute top: shown.
  if (scrollTop <= 0) {
    return true
  }

  // Already hidden and the reader is not back at the top: stay hidden.
  if (!currentlyVisible) {
    return false
  }

  // Scrolled away from the top, but giving the banner's height back would leave
  // the note with no meaningful scroll range — hiding would only cause a flicker.
  const remainingScrollRange = scrollHeight - clientHeight
  return remainingScrollRange <= bannerHeight
}
