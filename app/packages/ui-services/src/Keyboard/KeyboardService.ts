import { Environment, Platform, UuidGenerator } from '@standardnotes/snjs'
import { eventMatchesKeyAndModifiers } from './eventMatchesKeyAndModifiers'
import { KeyboardCommand } from './KeyboardCommands'
import { KeyboardKeyEvent } from './KeyboardKeyEvent'
import { KeyboardModifier } from './KeyboardModifier'
import { KeyboardCommandHandler } from './KeyboardCommandHandler'
import { KeyboardShortcut, KeyboardShortcutHelpItem, PlatformedKeyboardShortcut } from './KeyboardShortcut'
import { getKeyboardShortcuts } from './getKeyboardShortcuts'
import {
  KeyboardShortcutOverrides,
  loadKeyboardShortcutOverrides,
  persistKeyboardShortcutOverrides,
  SerializedKeyboardShortcut,
  serializeShortcut,
  shortcutsConflict,
} from './KeyboardShortcutOverrides'
import { descriptionForCommand } from './KeyboardCommandCatalog'

export type ConfigurableShortcut = {
  command: KeyboardCommand
  /** Stable persistence key (the command Symbol's description). */
  commandKey: string
  defaultShortcut: PlatformedKeyboardShortcut
  effectiveShortcut: PlatformedKeyboardShortcut
  isOverridden: boolean
}

export class KeyboardService {
  readonly activeModifiers = new Set<KeyboardModifier>()
  private commandHandlers = new Set<KeyboardCommandHandler>()
  private commandMap = new Map<KeyboardCommand, KeyboardShortcut>()

  /**
   * Standard Red Notes: the platform defaults, kept separate from the effective
   * {@link commandMap} so a user can reset an override back to the default chord.
   */
  private defaultShortcutMap = new Map<KeyboardCommand, KeyboardShortcut>()
  /** Map of `Symbol.description` -> stable command Symbol, for applying overrides. */
  private commandKeyToCommand = new Map<string, KeyboardCommand>()
  private overrides: KeyboardShortcutOverrides = {}
  private overrideChangeObservers = new Set<() => void>()

  private keyboardShortcutHelpItems = new Set<KeyboardShortcutHelpItem>()

  constructor(
    private platform: Platform,
    environment: Environment,
  ) {
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('blur', this.handleWindowBlur)

    const shortcuts = getKeyboardShortcuts(platform, environment)
    for (const shortcut of shortcuts) {
      this.defaultShortcutMap.set(shortcut.command, shortcut)
      const key = descriptionForCommand(shortcut.command)
      if (key) {
        this.commandKeyToCommand.set(key, shortcut.command)
      }
      this.registerShortcut(shortcut)
    }

    this.overrides = loadKeyboardShortcutOverrides()
    this.applyOverrides()
  }

  private isDisabled = false
  /**
   * When called, the service will stop triggering command handlers
   * on keydown/keyup events. Useful when you need to handle events
   * yourself while keeping the rest of behaviours inert.
   * Make sure to call {@link enableEventHandling} once done.
   */
  public disableEventHandling() {
    this.isDisabled = true
  }
  public enableEventHandling() {
    this.isDisabled = false
  }

  get isMac() {
    return this.platform === Platform.MacDesktop || this.platform === Platform.MacWeb
  }

  public deinit() {
    this.commandHandlers.clear()
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('blur', this.handleWindowBlur)
    ;(this.handleKeyDown as unknown) = undefined
    ;(this.handleKeyUp as unknown) = undefined
    ;(this.handleWindowBlur as unknown) = undefined
  }

  private addActiveModifier = (modifier: KeyboardModifier | undefined): void => {
    if (!modifier) {
      return
    }

    switch (modifier) {
      case KeyboardModifier.Meta: {
        if (this.isMac) {
          this.activeModifiers.add(modifier)
        }
        break
      }
      case KeyboardModifier.Ctrl: {
        if (!this.isMac) {
          this.activeModifiers.add(modifier)
        }
        break
      }
      default: {
        this.activeModifiers.add(modifier)
        break
      }
    }
  }

  private removeActiveModifier = (modifier: KeyboardModifier | undefined): void => {
    if (!modifier) {
      return
    }

    this.activeModifiers.delete(modifier)
  }

  public cancelAllKeyboardModifiers = (): void => {
    this.activeModifiers.clear()
  }

  public handleComponentKeyDown = (modifier: KeyboardModifier | undefined): void => {
    this.addActiveModifier(modifier)
  }

  public handleComponentKeyUp = (modifier: KeyboardModifier | undefined): void => {
    this.removeActiveModifier(modifier)
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    this.updateAllModifiersFromEvent(event)

    this.handleKeyboardEvent(event, KeyboardKeyEvent.Down)
  }

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.updateAllModifiersFromEvent(event)

    this.handleKeyboardEvent(event, KeyboardKeyEvent.Up)
  }

  private updateAllModifiersFromEvent(event: KeyboardEvent): void {
    for (const modifier of Object.values(KeyboardModifier)) {
      if (event.getModifierState(modifier)) {
        this.addActiveModifier(modifier)
      } else {
        this.removeActiveModifier(modifier)
      }
    }
  }

  handleWindowBlur = (): void => {
    for (const modifier of this.activeModifiers) {
      this.activeModifiers.delete(modifier)
    }
  }

  private handleKeyboardEvent(event: KeyboardEvent, keyEvent: KeyboardKeyEvent): void {
    if (this.isDisabled) {
      return
    }
    for (const command of this.commandMap.keys()) {
      const shortcut = this.commandMap.get(command)
      if (!shortcut) {
        continue
      }

      if (eventMatchesKeyAndModifiers(event, shortcut)) {
        if (shortcut.preventDefault) {
          event.preventDefault()
        }
        this.handleCommand(command, event, keyEvent)
      }
    }
  }

  private handleCommand(command: KeyboardCommand, event: KeyboardEvent, keyEvent: KeyboardKeyEvent): void {
    const target = event.target as HTMLElement

    for (const observer of Array.from(this.commandHandlers).reverse()) {
      if (observer.command !== command) {
        continue
      }

      if (observer.element && event.target !== observer.element) {
        continue
      }

      if (observer.elements && !observer.elements.includes(target)) {
        continue
      }

      if (observer.notElement && observer.notElement === event.target) {
        continue
      }

      if (observer.notElementIds && observer.notElementIds.includes(target.id)) {
        continue
      }

      if (observer.notTags && observer.notTags.includes(target.tagName)) {
        continue
      }

      const callback = keyEvent === KeyboardKeyEvent.Down ? observer.onKeyDown : observer.onKeyUp
      if (callback) {
        const exclusive = callback(event)
        if (exclusive) {
          return
        }
      }
    }
  }

  public triggerCommand(command: KeyboardCommand, data?: unknown): void {
    for (const observer of Array.from(this.commandHandlers).reverse()) {
      if (observer.command !== command) {
        continue
      }

      const callback = observer.onKeyDown || observer.onKeyUp
      if (callback) {
        const exclusive = callback(new KeyboardEvent('command-trigger'), data)
        if (exclusive) {
          return
        }
      }
    }
  }

  registerShortcut(shortcut: KeyboardShortcut): void {
    this.commandMap.set(shortcut.command, shortcut)
  }

  /**
   * Standard Red Notes: rebuilds the effective {@link commandMap} from the
   * defaults plus any user overrides. Commands without an override keep their
   * default chord, so existing shortcuts keep working untouched.
   */
  private applyOverrides(): void {
    for (const [command, defaultShortcut] of this.defaultShortcutMap.entries()) {
      const key = descriptionForCommand(command)
      const override = key ? this.overrides[key] : undefined

      if (override) {
        this.commandMap.set(command, {
          command,
          modifiers: override.modifiers,
          key: override.key,
          code: override.code,
          // preventDefault is a fixed behaviour of the command, never user-editable.
          preventDefault: defaultShortcut.preventDefault,
        })
      } else {
        this.commandMap.set(command, defaultShortcut)
      }
    }
  }

  private notifyOverrideObservers(): void {
    for (const observer of this.overrideChangeObservers) {
      observer()
    }
  }

  /** Subscribe to changes to user shortcut overrides. Returns a disposer. */
  addOverrideChangeObserver(observer: () => void): () => void {
    this.overrideChangeObservers.add(observer)
    return () => {
      this.overrideChangeObservers.delete(observer)
    }
  }

  /**
   * The list of commands that are exposed for user reassignment, with both their
   * default and currently-effective chords.
   */
  getConfigurableShortcuts(): ConfigurableShortcut[] {
    const result: ConfigurableShortcut[] = []
    for (const [command, defaultShortcut] of this.defaultShortcutMap.entries()) {
      const commandKey = descriptionForCommand(command)
      if (!commandKey) {
        continue
      }
      const effective = this.commandMap.get(command) ?? defaultShortcut
      result.push({
        command,
        commandKey,
        defaultShortcut: { platform: this.platform, ...defaultShortcut },
        effectiveShortcut: { platform: this.platform, ...effective },
        isOverridden: this.overrides[commandKey] != undefined,
      })
    }
    return result
  }

  /**
   * Returns the commandKey of an existing command whose effective chord matches
   * the proposed chord, excluding the command being edited. `undefined` means no
   * conflict.
   */
  findConflictingCommandKey(proposed: SerializedKeyboardShortcut, excludeCommandKey: string): string | undefined {
    for (const [command, shortcut] of this.commandMap.entries()) {
      const commandKey = descriptionForCommand(command)
      if (!commandKey || commandKey === excludeCommandKey) {
        continue
      }
      // Only consider commands that are part of the user-facing catalog.
      if (!this.commandKeyToCommand.has(commandKey)) {
        continue
      }
      if (shortcutsConflict(proposed, serializeShortcut(shortcut))) {
        return commandKey
      }
    }
    return undefined
  }

  /**
   * Override a command's chord. Pass a SerializedKeyboardShortcut to set, persists
   * and re-applies immediately so the new chord is live without a reload.
   */
  setShortcutOverride(commandKey: string, shortcut: SerializedKeyboardShortcut): void {
    if (!this.commandKeyToCommand.has(commandKey)) {
      return
    }
    this.overrides = { ...this.overrides, [commandKey]: shortcut }
    persistKeyboardShortcutOverrides(this.overrides)
    this.applyOverrides()
    this.notifyOverrideObservers()
  }

  /** Reset a single command back to its platform default. */
  resetShortcutOverride(commandKey: string): void {
    if (this.overrides[commandKey] == undefined) {
      return
    }
    const next = { ...this.overrides }
    delete next[commandKey]
    this.overrides = next
    persistKeyboardShortcutOverrides(this.overrides)
    this.applyOverrides()
    this.notifyOverrideObservers()
  }

  /** Reset every command back to its platform default. */
  resetAllShortcutOverrides(): void {
    if (Object.keys(this.overrides).length === 0) {
      return
    }
    this.overrides = {}
    persistKeyboardShortcutOverrides(this.overrides)
    this.applyOverrides()
    this.notifyOverrideObservers()
  }

  addCommandHandler(observer: KeyboardCommandHandler): () => void {
    this.commandHandlers.add(observer)

    const helpItem = this.getKeyboardShortcutHelpItemForHandler(observer)
    if (helpItem) {
      const existingItem = Array.from(this.keyboardShortcutHelpItems).find((item) => item.command === helpItem.command)
      if (existingItem) {
        this.keyboardShortcutHelpItems.delete(existingItem)
      }
      this.keyboardShortcutHelpItems.add(helpItem)
    }

    return () => {
      observer.onKeyDown = undefined
      observer.onKeyDown = undefined
      this.commandHandlers.delete(observer)
      if (helpItem) {
        this.keyboardShortcutHelpItems.delete(helpItem)
      }
    }
  }

  addCommandHandlers(handlers: KeyboardCommandHandler[]): () => void {
    const disposers = handlers.map((handler) => this.addCommandHandler(handler))
    return () => {
      for (const disposer of disposers) {
        disposer()
      }
    }
  }

  keyboardShortcutForCommand(command: KeyboardCommand): PlatformedKeyboardShortcut | undefined {
    const shortcut = this.commandMap.get(command)
    if (!shortcut) {
      return undefined
    }

    return {
      platform: this.platform,
      ...shortcut,
    }
  }

  getKeyboardShortcutHelpItemForHandler(handler: KeyboardCommandHandler): KeyboardShortcutHelpItem | undefined {
    const shortcut = this.keyboardShortcutForCommand(handler.command)

    if (!shortcut || !handler.category || !handler.description) {
      return undefined
    }

    return {
      ...shortcut,
      category: handler.category,
      description: handler.description,
      id: UuidGenerator.GenerateUuid(),
    }
  }

  /**
   * Register help item for a keyboard shortcut that is handled outside of the KeyboardService,
   * for example by a library like Lexical.
   */
  registerExternalKeyboardShortcutHelpItem(item: Omit<KeyboardShortcutHelpItem, 'id'>): () => void {
    const itemWithId = { ...item, id: UuidGenerator.GenerateUuid() }
    this.keyboardShortcutHelpItems.add(itemWithId)

    return () => {
      this.keyboardShortcutHelpItems.delete(itemWithId)
    }
  }

  /**
   * Register help item for a keyboard shortcut that is handled outside of the KeyboardService,
   * for example by a library like Lexical.
   */
  registerExternalKeyboardShortcutHelpItems(items: Omit<KeyboardShortcutHelpItem, 'id'>[]): () => void {
    const disposers = items.map((item) => this.registerExternalKeyboardShortcutHelpItem(item))

    return () => {
      for (const disposer of disposers) {
        disposer()
      }
    }
  }

  getRegisteredKeyboardShorcutHelpItems(): KeyboardShortcutHelpItem[] {
    return Array.from(this.keyboardShortcutHelpItems)
  }
}
