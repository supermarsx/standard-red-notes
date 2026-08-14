import {
  UIFeature,
  CreateDecryptedLocalStorageContextPayload,
  LocalStorageDecryptedContextualPayload,
  PrefDefaults,
  ComponentInterface,
} from '@standardnotes/models'
import {
  InternalEventBusInterface,
  ApplicationEvent,
  StorageValueModes,
  FeatureStatus,
  PreferenceServiceInterface,
  ComponentManagerInterface,
  LocalPrefKey,
  ColorSchemeMode,
  CurrentColorSchemeModeVersion,
} from '@standardnotes/services'
import { NativeFeatureIdentifier, FindNativeTheme, ThemeFeatureDescription } from '@standardnotes/features'
import { WebApplicationInterface } from '../WebApplication/WebApplicationInterface'
import { AbstractUIService } from '../Abstract/AbstractUIService'
import { GetAllThemesUseCase } from './GetAllThemesUseCase'
import { Uuid } from '@standardnotes/domain-core'
import { ActiveThemeList } from './ActiveThemeList'
import { Color } from './Color'
import { resolveColorSchemeTheme } from './ResolveColorSchemeTheme'

const CachedThemesKey = 'cachedThemes'
const LegacyDefaultThemeIdentifier = 'Default'
const DefaultThemeIdentifier = NativeFeatureIdentifier.TYPES.StandardRedTheme
const DefaultThemeBackgroundColor = '#16090f'

function isColorSchemeMode(value: unknown): value is ColorSchemeMode {
  return value === 'manual' || value === 'auto' || value === 'light' || value === 'dark'
}

export class ThemeManager extends AbstractUIService {
  private themesActiveInTheUI: ActiveThemeList
  private lastUseDeviceThemeSettings: boolean | undefined
  private lastAutoLightTheme: string | undefined
  private lastAutoDarkTheme: string | undefined
  private lastColorSchemeMode: ColorSchemeMode | undefined

  constructor(
    application: WebApplicationInterface,
    private preferences: PreferenceServiceInterface,
    private components: ComponentManagerInterface,
    internalEventBus: InternalEventBusInterface,
  ) {
    super(application, internalEventBus)
    this.colorSchemeEventHandler = this.colorSchemeEventHandler.bind(this)
    this.themesActiveInTheUI = new ActiveThemeList(application.items)
  }

  override deinit() {
    this.themesActiveInTheUI.clear()
    ;(this.themesActiveInTheUI as unknown) = undefined
    ;(this.preferences as unknown) = undefined
    ;(this.components as unknown) = undefined

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    if (mq.removeEventListener != undefined) {
      mq.removeEventListener('change', this.colorSchemeEventHandler)
    } else {
      mq.removeListener(this.colorSchemeEventHandler)
    }

    super.deinit()
  }

  override async onAppStart() {
    const desktopService = this.application.desktopManager
    if (desktopService) {
      this.eventDisposers.push(
        desktopService.registerUpdateObserver((component) => {
          const uiFeature = new UIFeature<ThemeFeatureDescription>(component)
          if (uiFeature.isThemeComponent) {
            if (this.components.isThemeActive(uiFeature)) {
              this.deactivateThemeInTheUI(uiFeature.uniqueIdentifier)
              setTimeout(() => {
                this.activateTheme(uiFeature)
                this.cacheThemeState().catch(console.error)
              }, 10)
            }
          }
        }),
      )
    }
  }

  override async onAppEvent(event: ApplicationEvent) {
    switch (event) {
      case ApplicationEvent.SignedOut: {
        this.deactivateAllThemes()
        this.themesActiveInTheUI.clear()
        this.application?.removeValue(CachedThemesKey, StorageValueModes.Nonwrapped).catch(console.error)
        break
      }
      case ApplicationEvent.StorageReady: {
        await this.activateCachedThemes()
        break
      }
      case ApplicationEvent.FeaturesAvailabilityChanged: {
        this.handleFeaturesAvailabilityChanged().catch(console.error)
        break
      }
      case ApplicationEvent.Launched: {
        if (!this.application.isNativeMobileWeb()) {
          const mq = window.matchMedia('(prefers-color-scheme: dark)')
          if (mq.addEventListener != undefined) {
            mq.addEventListener('change', this.colorSchemeEventHandler)
          } else {
            mq.addListener(this.colorSchemeEventHandler)
          }
        }
        // Cached theme links load before encrypted local preferences. Reconcile
        // them now so a stale light stylesheet cannot survive a dark/manual
        // selection merely because no preference change event was emitted.
        this.handleThemeStateChange()
        await this.applyColorSchemeMode()
        // Applying Dark can synchronously clear an ActiveThemes entry that kept
        // a cached light link alive during the first pass. Reconcile once more
        // so launch resolves only after the DOM reflects the migrated choice.
        this.handleThemeStateChange()
        break
      }
      case ApplicationEvent.LocalPreferencesChanged: {
        void this.handleLocalPreferencesChangeEvent()
        break
      }
    }
  }

  async handleMobileColorSchemeChangeEvent() {
    const colorSchemeMode = this.getColorSchemeMode()
    if (colorSchemeMode === 'auto') {
      const prefersDarkColorScheme = (await this.application.mobileDevice.getColorScheme()) === 'dark'
      if (this.getColorSchemeMode() === 'auto') {
        this.applyThemeByIdentifier(resolveColorSchemeTheme('auto', prefersDarkColorScheme))
      }
      return
    }

    const useDeviceThemeSettings =
      colorSchemeMode === 'manual' && this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)

    if (useDeviceThemeSettings) {
      const prefersDarkColorScheme = (await this.application.mobileDevice.getColorScheme()) === 'dark'
      if (
        this.getColorSchemeMode() === 'manual' &&
        this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)
      ) {
        this.setThemeAsPerColorScheme(prefersDarkColorScheme)
      }
    }
  }

  private handleThemeStateChange() {
    let hasChange = false

    const { features, uuids } = this.components.getActiveThemesIdentifiers()

    const featuresList = new ActiveThemeList(this.application.items, features)
    const uuidsList = new ActiveThemeList(this.application.items, uuids)

    for (const active of this.themesActiveInTheUI.getList()) {
      if (!featuresList.has(active) && !uuidsList.has(active)) {
        this.deactivateThemeInTheUI(active)
        hasChange = true
      }
    }

    for (const feature of features) {
      if (!this.themesActiveInTheUI.has(feature)) {
        const theme = FindNativeTheme(feature.value)
        if (theme) {
          const uiFeature = new UIFeature<ThemeFeatureDescription>(theme)
          this.activateTheme(uiFeature)
          hasChange = true
        }
      }
    }

    for (const uuid of uuids) {
      if (!this.themesActiveInTheUI.has(uuid)) {
        const theme = this.application.items.findItem<ComponentInterface>(uuid.value)
        if (theme) {
          const uiFeature = new UIFeature<ThemeFeatureDescription>(theme)
          this.activateTheme(uiFeature)
          hasChange = true
        }
      }
    }

    if (hasChange) {
      this.cacheThemeState().catch(console.error)
    }
  }

  private async handleLocalPreferencesChangeEvent() {
    this.handleThemeStateChange()

    this.toggleTranslucentUIColors()

    const useSystemColorScheme = this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)
    const autoLightTheme = this.preferences.getLocalValue(LocalPrefKey.AutoLightThemeIdentifier, DefaultThemeIdentifier)
    const autoDarkTheme = this.preferences.getLocalValue(
      LocalPrefKey.AutoDarkThemeIdentifier,
      NativeFeatureIdentifier.TYPES.DarkTheme,
    )
    const colorSchemeMode = this.getColorSchemeMode()

    const hasColorSchemeModeChanged = colorSchemeMode !== this.lastColorSchemeMode
    if (hasColorSchemeModeChanged) {
      this.lastColorSchemeMode = colorSchemeMode
      await this.applyColorSchemeMode()
    }

    const hasPreferenceChanged =
      useSystemColorScheme !== this.lastUseDeviceThemeSettings ||
      autoLightTheme !== this.lastAutoLightTheme ||
      autoDarkTheme !== this.lastAutoDarkTheme

    if (hasPreferenceChanged) {
      this.lastUseDeviceThemeSettings = useSystemColorScheme
      this.lastAutoLightTheme = autoLightTheme
      this.lastAutoDarkTheme = autoDarkTheme
    }

    if (hasPreferenceChanged && useSystemColorScheme && colorSchemeMode === 'manual') {
      let prefersDarkColorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches

      if (this.application.isNativeMobileWeb()) {
        prefersDarkColorScheme = (await this.application.mobileDevice.getColorScheme()) === 'dark'
      }

      this.setThemeAsPerColorScheme(prefersDarkColorScheme)
    }
  }

  /**
   * Returns a validated, migrated color-scheme mode. Older installations can
   * have an ActiveThemes selection without the newer mode key, while releases
   * before the dark-first default persisted Auto for otherwise untouched users.
   * That old value has no provenance to distinguish implicit from explicit Auto,
   * so version 1 deliberately resets it once. Choices made after the migration
   * retain their version marker, and malformed local state fails closed to Red.
   */
  private getColorSchemeMode(): ColorSchemeMode {
    const storedMode = this.preferences.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)
    const storedVersion = this.preferences.getLocalValue(LocalPrefKey.ColorSchemeModeVersion, undefined)

    if (typeof storedVersion !== 'number' || storedVersion < CurrentColorSchemeModeVersion) {
      const hasSavedTheme = this.preferences.getLocalValue(LocalPrefKey.ActiveThemes, []).length > 0
      const usesLegacySystemThemes = this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)
      const migratedMode: ColorSchemeMode =
        storedMode === undefined
          ? hasSavedTheme || usesLegacySystemThemes
            ? 'manual'
            : 'dark'
          : isColorSchemeMode(storedMode) && storedMode !== 'auto'
            ? storedMode
            : 'dark'

      this.preferences.setLocalValue(LocalPrefKey.ColorSchemeModeVersion, CurrentColorSchemeModeVersion)
      if (storedMode !== migratedMode) {
        this.preferences.setLocalValue(LocalPrefKey.ColorSchemeMode, migratedMode, { source: 'implicit' })
      }
      return migratedMode
    }

    if (isColorSchemeMode(storedMode)) {
      return storedMode
    }

    this.preferences.setLocalValue(LocalPrefKey.ColorSchemeMode, 'dark', { source: 'implicit' })
    return 'dark'
  }

  /**
   * Selects a theme as a direct user choice. Non-layerable themes own the base
   * color scheme, so remember them as manual and disable the older OS-theme
   * switch before changing ActiveThemes. Layerable themes remain overlays and
   * do not disturb Auto/Light/Dark.
   */
  async selectTheme(theme: UIFeature<ThemeFeatureDescription>): Promise<void> {
    if (!theme.layerable) {
      this.setColorSchemeMode('manual')
    }

    await this.components.toggleTheme(theme)
  }

  /** Selects the complete first-class Standard Red base theme. */
  async selectDefaultTheme(): Promise<void> {
    this.setColorSchemeMode('manual')

    const usecase = new GetAllThemesUseCase(this.application.items)
    const { native } = usecase.execute({ excludeLayerable: false })
    const standardRed = native.find(
      (theme) => theme.featureIdentifier === NativeFeatureIdentifier.TYPES.StandardRedTheme,
    )

    if (!standardRed) {
      const activeTheme = this.components.getActiveThemes().find((theme) => !theme.layerable)
      if (activeTheme) {
        await this.components.toggleTheme(activeTheme)
      }
      return
    }

    if (!this.components.isThemeActive(standardRed)) {
      await this.components.toggleTheme(standardRed, true)
    } else {
      this.components.toggleOtherNonLayerableThemes(standardRed)
    }
  }

  /**
   * Persists a base color-scheme mode and prevents the legacy system-theme
   * switch from racing it. The local preference service writes synchronously,
   * so subsequent theme events observe a coherent mode.
   */
  setColorSchemeMode(mode: ColorSchemeMode): void {
    if (this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)) {
      this.preferences.setLocalValue(LocalPrefKey.UseSystemColorScheme, false)
    }
    const storedVersion = this.preferences.getLocalValue(LocalPrefKey.ColorSchemeModeVersion, undefined)
    if (typeof storedVersion !== 'number' || storedVersion < CurrentColorSchemeModeVersion) {
      this.preferences.setLocalValue(LocalPrefKey.ColorSchemeModeVersion, CurrentColorSchemeModeVersion)
    }
    this.preferences.setLocalValue(LocalPrefKey.ColorSchemeMode, mode)
  }

  /**
   * Standard Red Notes: resolve the current OS dark-mode preference. Returns
   * `undefined` when it can't be determined (so Auto can fall back to dark).
   */
  private async getSystemPrefersDark(): Promise<boolean | undefined> {
    if (this.application.isNativeMobileWeb()) {
      try {
        return (await this.application.mobileDevice.getColorScheme()) === 'dark'
      } catch {
        return undefined
      }
    }

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    // A media query that matches neither dark nor light means the OS preference
    // is indeterminate; let the resolver apply its dark fallback.
    if (!mq.matches && !window.matchMedia('(prefers-color-scheme: light)').matches) {
      return undefined
    }
    return mq.matches
  }

  /**
   * Standard Red Notes: applies the active theme according to the auto/light/dark
   * color-scheme mode. `light` forces Standard Blue, `dark` forces Standard Red,
   * `auto` follows the OS (dark -> Standard Red, light -> Standard Blue, with a
   * dark fallback when the OS preference is indeterminate).
   */
  async applyColorSchemeMode(): Promise<boolean> {
    const mode = this.getColorSchemeMode()
    this.lastColorSchemeMode = mode

    if (mode === 'manual') {
      return false
    }

    const systemPrefersDark = mode === 'auto' ? await this.getSystemPrefersDark() : undefined
    if (this.getColorSchemeMode() !== mode) {
      return false
    }

    const themeIdentifier = resolveColorSchemeTheme(mode, systemPrefersDark)

    return this.applyThemeByIdentifier(themeIdentifier)
  }

  /**
   * Applies the non-layerable theme with the given identifier. Older clients
   * persisted `Default` for the implicit base; normalize it to the complete,
   * first-class Standard Red asset during activation.
   */
  private applyThemeByIdentifier(themeIdentifier: string | undefined): boolean {
    if (!themeIdentifier) {
      return false
    }

    let didChangeTheme = false

    const usecase = new GetAllThemesUseCase(this.application.items)
    const { thirdParty, native } = usecase.execute({ excludeLayerable: false })
    const themes = [...thirdParty, ...native]

    const activeTheme = themes.find((theme) => this.components.isThemeActive(theme) && !theme.layerable)

    const resolvedIdentifier =
      themeIdentifier === LegacyDefaultThemeIdentifier ? DefaultThemeIdentifier : themeIdentifier
    const theme = themes.find((candidate) => candidate.featureIdentifier === resolvedIdentifier)
    if (theme) {
      if (!this.components.isThemeActive(theme)) {
        this.components.toggleTheme(theme, true).catch(console.error)
      } else {
        this.components.toggleOtherNonLayerableThemes(theme)
      }
      didChangeTheme = true
    } else if (activeTheme) {
      // Requested theme isn't installed/available; fall back to the base look.
      void this.components.toggleTheme(activeTheme)
      didChangeTheme = true
    }

    return didChangeTheme
  }

  private async handleFeaturesAvailabilityChanged() {
    let hasChange = false

    for (const theme of this.themesActiveInTheUI.asThemes()) {
      const status = this.application.features.getFeatureStatus(theme.uniqueIdentifier)
      if (status !== FeatureStatus.Entitled) {
        this.deactivateThemeInTheUI(theme.uniqueIdentifier)
        hasChange = true
      }
    }

    const activeThemes = this.components.getActiveThemes()

    for (const theme of activeThemes) {
      if (!this.themesActiveInTheUI.has(theme.uniqueIdentifier)) {
        this.activateTheme(theme)
        hasChange = true
      }
    }

    const colorSchemeMode = this.getColorSchemeMode()
    if (colorSchemeMode !== 'manual') {
      hasChange = (await this.applyColorSchemeMode()) || hasChange
    } else if (this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)) {
      let prefersDarkColorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (this.application.isNativeMobileWeb()) {
        prefersDarkColorScheme = (await this.application.mobileDevice.getColorScheme()) === 'dark'
      }
      hasChange = this.setThemeAsPerColorScheme(prefersDarkColorScheme) || hasChange
    }

    if (hasChange) {
      void this.cacheThemeState()
    }
  }

  private colorSchemeEventHandler(event: MediaQueryListEvent) {
    // Standard Red Notes: when the color-scheme mode is Auto, follow the OS live.
    const colorSchemeMode = this.getColorSchemeMode()
    if (colorSchemeMode === 'auto') {
      this.applyThemeByIdentifier(resolveColorSchemeTheme('auto', event.matches))
      return
    }

    // Legacy "use system color scheme" path (with the two auto theme dropdowns).
    const shouldChangeTheme = this.preferences.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)

    if (colorSchemeMode === 'manual' && shouldChangeTheme) {
      this.setThemeAsPerColorScheme(event.matches)
    }
  }

  private setThemeAsPerColorScheme(prefersDarkColorScheme: boolean): boolean {
    let didChangeTheme = false

    const preference = prefersDarkColorScheme
      ? LocalPrefKey.AutoDarkThemeIdentifier
      : LocalPrefKey.AutoLightThemeIdentifier

    const preferenceDefault =
      preference === LocalPrefKey.AutoDarkThemeIdentifier
        ? NativeFeatureIdentifier.TYPES.DarkTheme
        : DefaultThemeIdentifier

    const usecase = new GetAllThemesUseCase(this.application.items)
    const { thirdParty, native } = usecase.execute({ excludeLayerable: false })
    const themes = [...thirdParty, ...native]

    const activeTheme = themes.find((theme) => this.components.isThemeActive(theme) && !theme.layerable)

    const themeIdentifier = this.preferences.getLocalValue(preference, preferenceDefault)

    const toggleActiveTheme = () => {
      if (activeTheme) {
        void this.components.toggleTheme(activeTheme)
        didChangeTheme = true
      }
    }

    const resolvedIdentifier =
      themeIdentifier === LegacyDefaultThemeIdentifier ? DefaultThemeIdentifier : themeIdentifier
    const theme = themes.find((candidate) => candidate.featureIdentifier === resolvedIdentifier)
    if (theme) {
      if (!this.components.isThemeActive(theme)) {
        this.components.toggleTheme(theme, true).catch(console.error)
      } else {
        this.components.toggleOtherNonLayerableThemes(theme)
      }
      didChangeTheme = true
    } else {
      toggleActiveTheme()
    }

    return didChangeTheme
  }

  private async activateCachedThemes() {
    const cachedThemes = this.getCachedThemes()
    for (const theme of cachedThemes) {
      this.activateTheme(theme, true)
    }
  }

  private deactivateAllThemes() {
    const activeThemes = this.themesActiveInTheUI.getList()
    for (const uuid of activeThemes) {
      this.deactivateThemeInTheUI(uuid)
    }
  }

  private activateTheme(theme: UIFeature<ThemeFeatureDescription>, skipEntitlementCheck = false) {
    if (this.themesActiveInTheUI.has(theme.uniqueIdentifier)) {
      return
    }

    if (
      !skipEntitlementCheck &&
      this.application.features.getFeatureStatus(theme.uniqueIdentifier) !== FeatureStatus.Entitled
    ) {
      return
    }

    const url = this.application.componentManager.urlForFeature(theme)
    if (!url) {
      return
    }

    this.themesActiveInTheUI.add(theme.uniqueIdentifier)

    const link = document.createElement('link')
    link.href = url
    link.type = 'text/css'
    link.rel = 'stylesheet'
    link.media = 'screen,print'
    link.id = theme.uniqueIdentifier.value
    link.onload = () => {
      this.syncThemeColorMetadata()

      if (this.application.isNativeMobileWeb()) {
        setTimeout(() => {
          const backgroundColorString = this.getBackgroundColor()
          const backgroundColor = new Color(backgroundColorString)
          this.application.mobileDevice.handleThemeSchemeChange(backgroundColor.isDark(), backgroundColorString)
        })
      }

      this.toggleTranslucentUIColors()
    }
    document.getElementsByTagName('head')[0].appendChild(link)
  }

  private deactivateThemeInTheUI(id: NativeFeatureIdentifier | Uuid) {
    if (!this.themesActiveInTheUI.has(id)) {
      return
    }

    const element = document.getElementById(id.value) as HTMLLinkElement
    if (element) {
      element.disabled = true
      element.parentNode?.removeChild(element)
    }

    this.themesActiveInTheUI.remove(id)

    // Removing a theme exposes the underlying palette. Keep browser chrome and
    // native shells in sync with that palette instead of retaining light-theme
    // metadata after the stylesheet is gone.
    this.syncThemeColorMetadata()

    if (this.themesActiveInTheUI.isEmpty()) {
      if (this.application.isNativeMobileWeb()) {
        const backgroundColorString = this.getBackgroundColor()
        const backgroundColor = new Color(backgroundColorString)
        this.application.mobileDevice.handleThemeSchemeChange(backgroundColor.isDark(), backgroundColorString)
      }
      this.toggleTranslucentUIColors()
    }
  }

  private getBackgroundColor() {
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--sn-stylekit-background-color').trim()
    return bgColor.length ? bgColor : DefaultThemeBackgroundColor
  }

  private shouldUseTranslucentUI() {
    return this.preferences.getLocalValue(LocalPrefKey.UseTranslucentUI, PrefDefaults[LocalPrefKey.UseTranslucentUI])
  }

  private toggleTranslucentUIColors() {
    if (!this.shouldUseTranslucentUI()) {
      document.documentElement.style.removeProperty('--popover-background-color')
      document.documentElement.style.removeProperty('--popover-backdrop-filter')
      document.body.classList.remove('translucent-ui')
      return
    }
    try {
      const backgroundColor = new Color(this.getBackgroundColor())
      const backdropFilter = backgroundColor.isDark()
        ? 'blur(12px) saturate(190%) contrast(70%) brightness(80%)'
        : 'blur(12px) saturate(190%) contrast(50%) brightness(130%)'
      const translucentBackgroundColor = backgroundColor.setAlpha(0.65).toString()
      document.documentElement.style.setProperty('--popover-background-color', translucentBackgroundColor)
      document.documentElement.style.setProperty('--popover-backdrop-filter', backdropFilter)
      document.body.classList.add('translucent-ui')
    } catch (error) {
      console.error(error)
    }
  }

  /**
   * Syncs the active theme's background color to the 'theme-color' meta tag
   * https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta/name/theme-color
   */
  private syncThemeColorMetadata() {
    const themeColorMetaElement = document.querySelector('meta[name="theme-color"]')
    if (!themeColorMetaElement) {
      return
    }

    themeColorMetaElement.setAttribute('content', this.getBackgroundColor())
  }

  private async cacheThemeState() {
    const themes = this.themesActiveInTheUI.asThemes()

    const mapped = themes.map((theme) => {
      if (theme.isComponent) {
        const payload = theme.asComponent.payloadRepresentation()
        return CreateDecryptedLocalStorageContextPayload(payload)
      } else {
        const payload = theme.asFeatureDescription
        return payload
      }
    })

    return this.application.setValue(CachedThemesKey, mapped, StorageValueModes.Nonwrapped)
  }

  private getCachedThemes(): UIFeature<ThemeFeatureDescription>[] {
    const cachedThemes = this.application.getValue<LocalStorageDecryptedContextualPayload[]>(
      CachedThemesKey,
      StorageValueModes.Nonwrapped,
    )

    if (!cachedThemes) {
      return []
    }

    const features: UIFeature<ThemeFeatureDescription>[] = []

    for (const cachedTheme of cachedThemes) {
      if ('uuid' in cachedTheme) {
        const payload = this.application.items.createPayloadFromObject(cachedTheme)
        const theme = this.application.items.createItemFromPayload<ComponentInterface>(payload)
        features.push(new UIFeature<ThemeFeatureDescription>(theme))
      } else if ('identifier' in cachedTheme) {
        const feature = FindNativeTheme((cachedTheme as ThemeFeatureDescription).identifier)
        if (feature) {
          features.push(new UIFeature<ThemeFeatureDescription>(feature))
        }
      }
    }

    return features
  }
}
