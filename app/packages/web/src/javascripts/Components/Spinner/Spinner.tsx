type Props = {
  className?: string
  /**
   * When true, the ring is drawn in `border-info-contrast` (for colored/filled
   * buttons) while still guaranteeing the visible spin gap: `border-r-transparent`
   * is emitted LAST so it wins source order over the contrast color. Replaces the
   * old pattern of callers appending a full `border-info-contrast` class, which
   * could fill the gap and make the ring look solid/static.
   */
  contrast?: boolean
}

const Spinner = ({ className = '', contrast = false }: Props) => {
  // Sane default size: if the caller forgot to pass a width/height class, a
  // 0px (invisible) spinner would render. Prepend `h-4 w-4` in that case.
  const hasSize = /(?:^|\s)[wh]-/.test(className)
  const sizeClass = hasSize ? '' : 'h-4 w-4'

  // border-r-transparent must come LAST so the spin gap wins source order,
  // especially against the contrast color.
  const colorClasses = contrast ? 'border-info-contrast border-r-transparent' : 'border-info border-r-transparent'

  return (
    <div
      className={`animate-spin rounded-full border border-solid ${sizeClass} ${className} ${colorClasses}`.trim()}
    />
  )
}

export default Spinner
