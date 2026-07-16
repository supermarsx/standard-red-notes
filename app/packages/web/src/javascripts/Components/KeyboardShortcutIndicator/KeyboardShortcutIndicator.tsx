import { classNames } from '@standardnotes/snjs'
import {
  PlatformedKeyboardShortcut,
  keyboardCharacterForModifier,
  isMobilePlatform,
  keyboardCharacterForKeyOrCode,
  KeyboardModifier,
} from '@standardnotes/ui-services'
import { useMemo } from 'react'

type Props = {
  shortcut: Omit<PlatformedKeyboardShortcut, 'command'>
  small?: boolean
  dimmed?: boolean
  className?: string
}

export const KeyboardShortcutIndicator = ({ shortcut, small = true, dimmed = true, className }: Props) => {
  const keys = useMemo(() => {
    const modifiers = shortcut.modifiers || []
    const primaryKey = shortcut.key
      ? keyboardCharacterForKeyOrCode(shortcut.key)
      : shortcut.code
        ? keyboardCharacterForKeyOrCode(shortcut.code, modifiers.includes(KeyboardModifier.Shift))
        : undefined

    const results: string[] = []
    modifiers.forEach((modifier) => {
      results.push(keyboardCharacterForModifier(modifier, shortcut.platform))
    })

    if (primaryKey) {
      results.push(primaryKey)
    }

    return results
  }, [shortcut])

  if (isMobilePlatform(shortcut.platform)) {
    return null
  }

  return (
    <div className={classNames('flex items-center gap-1', dimmed && 'opacity-70', className)}>
      {keys.map((key, index) => {
        return (
          <kbd
            className={classNames(
              'border-passive-3 bg-default text-text shadow-passive-3 rounded border-[0.5px] p-1 text-center font-sans leading-none capitalize shadow-[var(--tw-shadow-color)_0px_2px_0px_0px]',
              small ? 'text-[length:0.65rem]' : 'text-xs',
            )}
            key={index}
          >
            {key}
          </kbd>
        )
      })}
    </div>
  )
}
