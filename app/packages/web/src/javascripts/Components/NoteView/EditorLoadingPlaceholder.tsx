import { FunctionComponent } from 'react'
import Spinner from '@/Components/Spinner/Spinner'

type Props = {
  /** What is loading; shown beneath the skeleton. Defaults to "editor". */
  label?: string
}

/**
 * Tasteful animated loading state for lazy-loaded editors. Instead of a blank
 * flash while the editor chunk downloads, we show a soft shimmering skeleton
 * that roughly mirrors the shape of editor content (a title line plus a few
 * paragraph lines) with a subtle spinner + caption.
 *
 * The `animate-pulse` shimmer is essential loading feedback, so under
 * `prefers-reduced-motion` it keeps looping (gently, ~2s) rather than freezing:
 * the reduced-motion allowlist in `_animation.scss` exempts `animate-pulse` from
 * the universal clamp instead of collapsing it to a single static frame. That
 * keeps it feeling alive rather than appearing frozen/broken.
 */
const SkeletonLine: FunctionComponent<{ className?: string }> = ({ className }) => (
  <div className={`bg-passive-3 h-3.5 rounded ${className ?? ''}`} />
)

const EditorLoadingPlaceholder: FunctionComponent<Props> = ({ label = 'editor' }) => (
  <div className="flex h-full w-full flex-col p-4" role="status" aria-live="polite" aria-busy="true">
    <div className="animate-pulse">
      {/* Title placeholder */}
      <SkeletonLine className="mb-5 h-5 w-2/5" />
      {/* Paragraph placeholders */}
      <div className="flex flex-col gap-3">
        <SkeletonLine className="w-11/12" />
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-10/12" />
        <SkeletonLine className="w-4/6" />
        <SkeletonLine className="mt-4 w-9/12" />
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-3/6" />
      </div>
    </div>

    <div className="text-passive-1 mt-auto flex items-center gap-2 pt-6 text-sm">
      <Spinner className="h-4 w-4" />
      <span>Loading {label}…</span>
    </div>

    <span className="sr-only">Loading {label}</span>
  </div>
)

export default EditorLoadingPlaceholder
