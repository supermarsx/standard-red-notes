import { CSSProperties, FunctionComponent, HTMLAttributes } from 'react'

/**
 * Reusable loading-skeleton primitives.
 *
 * These render soft, theme-aware placeholder shapes while real content is
 * loading, instead of a blank flash or a bare "Loading…" string. They follow
 * the idiom already established in `NoteView/EditorLoadingPlaceholder.tsx`:
 * `animate-pulse` over `bg-passive-3` rounded divs, using CSS-var color tokens
 * so they look right in both the light and dark themes.
 *
 * Motion is CSS-only (`animate-pulse`). It is essential loading feedback, not
 * decoration, so under `prefers-reduced-motion` it is deliberately NOT frozen:
 * the reduced-motion allowlist in `_animation.scss` exempts `animate-pulse` from
 * the universal clamp and re-asserts it as an infinite loop (slowed to a gentle
 * ~2s breathe). A frozen skeleton looks broken; a gentle loop still reads as
 * "loading". No per-component JS is needed here.
 */

const BASE = 'animate-pulse rounded bg-passive-3'

/** Join class names, dropping falsy entries. */
const cx = (...classes: Array<string | undefined | false>): string => classes.filter(Boolean).join(' ')

/** Extra div attributes (e.g. `data-testid`, event handlers) accepted by every primitive. */
type DivPassthrough = Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>

type SkeletonLineProps = DivPassthrough & {
  className?: string
  /** CSS width (e.g. '60%', '12rem'). Prefer a Tailwind width class via `className` when possible. */
  width?: string
  /** CSS height. Defaults to the ~14px line height used by the editor placeholder. */
  height?: string
}

/** A single text-line placeholder. */
export const SkeletonLine: FunctionComponent<SkeletonLineProps> = ({ className, width, height, ...rest }) => {
  const style: CSSProperties = {}
  if (width) {
    style.width = width
  }
  if (height) {
    style.height = height
  }
  return <div className={cx(BASE, 'h-3.5', className)} style={style} {...rest} />
}

type SkeletonBlockProps = DivPassthrough & {
  className?: string
  width?: string
  height?: string
}

/** A rectangular block placeholder (cards, thumbnails, usage bars, etc.). */
export const SkeletonBlock: FunctionComponent<SkeletonBlockProps> = ({ className, width, height, ...rest }) => {
  const style: CSSProperties = {}
  if (width) {
    style.width = width
  }
  if (height) {
    style.height = height
  }
  return <div className={cx(BASE, 'h-16 w-full', className)} style={style} {...rest} />
}

type SkeletonCircleProps = DivPassthrough & {
  className?: string
  /** CSS width/height for the circle (e.g. '2.5rem', '40px'). Defaults to 2.5rem. */
  size?: string
}

/** A circular placeholder (avatars, icons). */
export const SkeletonCircle: FunctionComponent<SkeletonCircleProps> = ({ className, size = '2.5rem', ...rest }) => (
  <div
    className={cx('animate-pulse rounded-full bg-passive-3', className)}
    style={{ width: size, height: size }}
    {...rest}
  />
)

type SkeletonListProps = {
  /** Number of placeholder rows to render. */
  count?: number
  /** Class applied to the list wrapper. */
  className?: string
  /** Class applied to each row. */
  rowClassName?: string
  /** Visually-hidden label announced to screen readers. */
  label?: string
}

/**
 * A vertical stack of `count` line placeholders — the common case for a list of
 * items still loading (notes list, preference breakdowns, …). The wrapper
 * carries `role="status"` + `aria-busy` and a visually-hidden label so assistive
 * tech announces the loading state.
 */
export const SkeletonList: FunctionComponent<SkeletonListProps> = ({
  count = 6,
  className,
  rowClassName,
  label = 'Loading',
}) => (
  <div className={cx('flex flex-col gap-3', className)} role="status" aria-busy="true" aria-live="polite">
    {Array.from({ length: count }, (_, index) => (
      <SkeletonLine key={index} className={cx('w-full', rowClassName)} data-testid="skeleton-row" />
    ))}
    <span className="sr-only">{label}</span>
  </div>
)
