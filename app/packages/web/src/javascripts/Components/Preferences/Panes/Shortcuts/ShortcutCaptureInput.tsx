import { classNames, Platform } from '@standardnotes/snjs'
import {
  isMacPlatform,
  keyboardCharacterForKeyOrCode,
  keyboardCharacterForModifier,
  KeyboardModifier,
  modifiersForEvent,
  SerializedKeyboardShortcut,
} from '@standardnotes/ui-services'
import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

type Props = {
  platform: Platform
  onCapture: (shortcut: SerializedKeyboardShortcut) => void
  onCancel: () => void
}

const MODIFIER_KEYS = new Set<string>([
  KeyboardModifier.Shift,
  KeyboardModifier.Ctrl,
  KeyboardModifier.Meta,
  KeyboardModifier.Alt,
])

/**
 * Standard Red Notes: a "press keys" capture input used in the Keyboard shortcuts
 * preferences pane. It listens for a single keydown, derives the modifier set
 * with the same {@link modifiersForEvent} helper the KeyboardService uses (so
 * Cmd/Ctrl platform differences are preserved), and reports the captured chord.
 *
 * We require at least one non-modifier key, and we store both `key` and `code`
 * the same way the defaults do: a printable character is stored as `key`, while
 * letters/digits are stored as `code` (e.g. 'KeyN') so Alt/Shift remapping on
 * Mac doesn't corrupt the character.
 */
const ShortcutCaptureInput = ({ platform, onCapture, onCancel }: Props) => {
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string[]>([])

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const buildPreview = useCallback(
    (modifiers: KeyboardModifier[], key?: string) => {
      const parts: string[] = modifiers.map((modifier) => keyboardCharacterForModifier(modifier, platform))
      if (key) {
        parts.push(key)
      }
      return parts
    },
    [platform],
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        onCancel()
        return
      }

      const modifiers = modifiersForEvent(event.nativeEvent)

      // Ignore standalone modifier presses; wait for an actual key.
      if (MODIFIER_KEYS.has(event.key)) {
        setPreview(buildPreview(modifiers))
        return
      }

      const serialized: SerializedKeyboardShortcut = {}
      if (modifiers.length > 0) {
        serialized.modifiers = modifiers
      }

      // Letters and digits are stored as code so Alt/Shift remapping is stable.
      const isLetterOrDigit = /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
      let displayKey: string
      if (isLetterOrDigit) {
        serialized.code = event.code
        displayKey = keyboardCharacterForKeyOrCode(event.code)
      } else {
        serialized.key = event.key
        displayKey = keyboardCharacterForKeyOrCode(event.key)
      }

      setPreview(buildPreview(modifiers, displayKey))
      onCapture(serialized)
    },
    [buildPreview, onCancel, onCapture],
  )

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="textbox"
      aria-label="Press the desired key combination"
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      className={classNames(
        'flex min-h-9 min-w-40 cursor-pointer items-center justify-center gap-1 rounded border border-dashed',
        'border-info bg-default px-3 py-1.5 text-sm outline-none ring-info focus:ring-2',
      )}
    >
      {preview.length > 0 ? (
        preview.map((part, index) => (
          <kbd
            key={index}
            className="rounded border-[0.5px] border-passive-3 bg-default p-1 text-center font-sans capitalize leading-none text-text"
          >
            {part}
          </kbd>
        ))
      ) : (
        <span className="text-passive-1">{isMacPlatform(platform) ? 'Press keys…' : 'Press keys…'}</span>
      )}
    </div>
  )
}

export default ShortcutCaptureInput
