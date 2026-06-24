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
