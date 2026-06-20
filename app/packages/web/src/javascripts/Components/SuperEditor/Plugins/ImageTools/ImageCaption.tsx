import { useEffect, useRef } from 'react'

type Props = {
  caption: string
  /** Whether the caption row should be rendered at all. */
  enabled: boolean
  onChange: (caption: string) => void
}

/**
 * Editable caption shown under an image. Uses a contentEditable span so it can
 * sit inside the Lexical decorator block without spawning a nested editor. The
 * value is committed to the node's `caption` attribute on blur (and on Enter).
 *
 * Keyboard events are stopped from propagating so typing in the caption doesn't
 * trigger Lexical editor shortcuts.
 */
export default function ImageCaption({ caption, enabled, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el && el.textContent !== caption) {
      el.textContent = caption
    }
  }, [caption])

  if (!enabled) {
    return null
  }

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label="Image caption"
      contentEditable
      suppressContentEditableWarning
      data-image-caption="true"
      className="mt-1 min-h-[1.5rem] w-full max-w-full px-1 text-center text-sm italic text-passive-1 outline-none focus:bg-contrast"
      data-placeholder="Add a caption…"
      onClick={(e) => {
        e.stopPropagation()
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).blur()
        }
      }}
      onBlur={(e) => {
        onChange(e.currentTarget.textContent ?? '')
      }}
    />
  )
}
