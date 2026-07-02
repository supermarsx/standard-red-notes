/**
 * Pure math/decision helpers for the toast drag-right-to-dismiss gesture.
 *
 * Kept free of DOM and React so the thresholds are unit-testable: Toast.tsx owns
 * the pointer plumbing and calls into these to decide what a gesture means.
 */

/** Horizontal movement (px) beyond which a pointer-down becomes a drag (and the
 * subsequent click is suppressed). Small enough to feel immediate, large enough
 * that ordinary clicks/taps never trigger it. */
export const DRAG_ACTIVATION_SLOP_PX = 6

/** Fraction of the toast's width that must be dragged right for a release to dismiss. */
export const DISMISS_DISTANCE_FRACTION = 0.4

/** Rightward release velocity (px/ms) that counts as a dismissal flick even
 * before the distance threshold is reached. */
export const FLICK_VELOCITY_PX_PER_MS = 0.65

/** A flick still needs to have travelled at least this far to dismiss. */
export const FLICK_MIN_DISTANCE_PX = 30

/** Only samples this recent (ms) participate in the release-velocity estimate. */
export const VELOCITY_WINDOW_MS = 100

/** Duration (ms) of the spring-back/slide-out transitions (unless reduced motion). */
export const DRAG_SETTLE_MS = 180

/** Leftward drags resist: the toast only follows a fraction of the pointer. */
export const LEFTWARD_RESISTANCE = 0.15

export type DragSample = { x: number; t: number }

/** Whether pointer travel is large enough to treat the gesture as a drag. */
export const isDragActivated = (dx: number): boolean => Math.abs(dx) >= DRAG_ACTIVATION_SLOP_PX

/** Rightward drags follow the pointer 1:1; leftward drags are heavily dampened. */
export const dampenDx = (dx: number): number => (dx >= 0 ? dx : dx * LEFTWARD_RESISTANCE)

/** Opacity while dragging right — fades toward (but never fully reaches) transparent. */
export const dragOpacity = (dx: number, width: number): number => {
  if (dx <= 0 || width <= 0) {
    return 1
  }
  return Math.max(0.2, 1 - (dx / width) * 0.9)
}

/**
 * Signed horizontal velocity (px/ms) at release, estimated over the trailing
 * {@link VELOCITY_WINDOW_MS}. Falls back to the last two samples when the window
 * is too sparse; 0 when there is not enough data.
 */
export const computeReleaseVelocity = (samples: readonly DragSample[], now: number): number => {
  const windowed = samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS)
  const usable = windowed.length >= 2 ? windowed : samples.slice(-2)
  if (usable.length < 2) {
    return 0
  }
  const first = usable[0]
  const last = usable[usable.length - 1]
  const dt = last.t - first.t
  if (dt <= 0) {
    return 0
  }
  return (last.x - first.x) / dt
}

/**
 * Whether releasing at `dx` (px right of the grab point) with `velocity` (px/ms)
 * dismisses the toast: past ~{@link DISMISS_DISTANCE_FRACTION} of its width, or a
 * rightward flick. Leftward positions never dismiss.
 */
export const shouldDismissOnRelease = (dx: number, width: number, velocity: number): boolean => {
  if (dx <= 0) {
    return false
  }
  if (width > 0 && dx >= width * DISMISS_DISTANCE_FRACTION) {
    return true
  }
  return velocity >= FLICK_VELOCITY_PX_PER_MS && dx >= FLICK_MIN_DISTANCE_PX
}
