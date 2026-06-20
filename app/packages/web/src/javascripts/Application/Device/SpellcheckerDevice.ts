/**
 * Structural contract for the desktop (Electron) spellchecker language
 * selection that is exposed by the desktop package's DesktopDevice /
 * RemoteBridge. These methods are intentionally NOT part of the shared
 * DesktopDeviceInterface (which lives in @standardnotes/services) because
 * multi-language spellcheck selection is a desktop-only capability that the
 * web build cannot provide. The web UI casts the desktop device to this
 * interface to read available languages and read/write the selected set.
 */
export interface SpellcheckerLanguageDescriptor {
  code: string
  name: string
  enabled: boolean
}

export interface SpellcheckerDevice {
  /**
   * False on macOS, where the OS owns spellchecking and languages cannot be
   * chosen from within the app.
   */
  isSpellCheckerManagerAvailable(): boolean
  getSpellCheckerLanguages(): SpellcheckerLanguageDescriptor[]
  setSpellCheckerLanguages(codes: string[]): void
}

/**
 * Narrows an unknown desktop device to the SpellcheckerDevice contract.
 * Returns undefined when the device does not implement the spellchecker
 * methods (e.g. older desktop builds or the web build).
 */
export function asSpellcheckerDevice(device: unknown): SpellcheckerDevice | undefined {
  if (
    device &&
    typeof (device as SpellcheckerDevice).isSpellCheckerManagerAvailable === 'function' &&
    typeof (device as SpellcheckerDevice).getSpellCheckerLanguages === 'function' &&
    typeof (device as SpellcheckerDevice).setSpellCheckerLanguages === 'function'
  ) {
    return device as SpellcheckerDevice
  }

  return undefined
}
