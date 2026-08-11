import {
  ContentType,
  FeatureStatus,
  PreferencesServiceEvent,
  ThemeFeatureDescription,
  UIFeature,
} from '@standardnotes/snjs'
import { GetAllThemesUseCase } from '@standardnotes/ui-services'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import { sortThemes } from '@/Utils/SortThemes'
import { Subtitle, Text } from '../../PreferencesComponents/Content'
import { hasSelectedCustomTheme, selectBuiltInTheme, STANDARD_RED_SWATCH } from './ThemeSelection'

type Props = {
  application: WebApplication
  /** Test seam for exercising stream refreshes without constructing sync items. */
  loadThemes?: () => UIFeature<ThemeFeatureDescription>[]
}

const BaseThemePalette: FunctionComponent<Props> = ({ application, loadThemes }) => {
  const premiumModal = usePremiumModal()
  const [themes, setThemes] = useState<UIFeature<ThemeFeatureDescription>[]>([])

  const reloadThemes = useCallback(() => {
    if (loadThemes) {
      setThemes([...loadThemes()].sort(sortThemes))
      return
    }
    const usecase = new GetAllThemesUseCase(application.items)
    const { native, thirdParty } = usecase.execute({ excludeLayerable: true })
    setThemes([...thirdParty, ...native].sort(sortThemes))
  }, [application, loadThemes])

  useEffect(() => {
    reloadThemes()
    const removeThemeStream = application.items.streamItems(ContentType.TYPES.Theme, reloadThemes)
    const removePreferenceObserver = application.preferences.addEventObserver((event) => {
      if (event === PreferencesServiceEvent.LocalPreferencesChanged) {
        reloadThemes()
      }
    })

    return () => {
      removeThemeStream()
      removePreferenceObserver()
    }
  }, [application, reloadThemes])

  const customThemeActive = hasSelectedCustomTheme(application)
  const activeBaseTheme = application.componentManager.getActiveThemes().find((theme) => !theme.layerable)
  const standardRedActive = !customThemeActive && !activeBaseTheme

  const activateTheme = useCallback(
    (theme: UIFeature<ThemeFeatureDescription>) => {
      const isThirdPartyTheme = application.features.isThirdPartyFeature(theme.featureIdentifier)
      const entitled = application.features.getFeatureStatus(theme.uniqueIdentifier) === FeatureStatus.Entitled
      if (!entitled && !isThirdPartyTheme) {
        premiumModal.activate(`${theme.displayName} theme`)
        return
      }

      void selectBuiltInTheme(application, theme)
    },
    [application, premiumModal],
  )

  const paletteButtonClasses = (active: boolean) =>
    classNames(
      'border-border bg-default hover:border-info flex min-h-16 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
      'focus:border-info focus:ring-info focus:ring-2 focus:ring-offset-2 focus:ring-offset-default focus:outline-none',
      active && 'border-info bg-info-backdrop',
    )

  return (
    <section className="mt-4" aria-label="Base theme settings">
      <Subtitle>Base theme</Subtitle>
      <Text>Choose the theme used on this device and workspace. Your choice is available offline.</Text>
      <div
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
        role="radiogroup"
        aria-label="Base theme"
      >
        <button
          type="button"
          role="radio"
          aria-checked={standardRedActive}
          data-theme-id="Default"
          className={paletteButtonClasses(standardRedActive)}
          onClick={() => void selectBuiltInTheme(application)}
        >
          <span
            className="border-contrast h-8 w-8 flex-shrink-0 rounded-full border-2 shadow-sm"
            style={{ backgroundColor: STANDARD_RED_SWATCH }}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Standard Red</span>
            <span className="text-passive-0 block text-xs">Built-in dark base</span>
          </span>
          {standardRedActive && <span className="text-info text-xs font-bold">Active</span>}
        </button>

        {themes.map((theme) => {
          const active = !customThemeActive && application.componentManager.isThemeActive(theme)
          const swatch = theme.dockIcon?.background_color ?? 'var(--sn-stylekit-info-color)'
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              data-theme-id={theme.uniqueIdentifier.value}
              className={paletteButtonClasses(active)}
              onClick={() => activateTheme(theme)}
              key={theme.uniqueIdentifier.value}
            >
              <span
                className="border-contrast h-8 w-8 flex-shrink-0 rounded-full border-2 shadow-sm"
                style={{ backgroundColor: swatch }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{theme.displayName}</span>
                <span className="text-passive-0 block text-xs">
                  {application.features.isThirdPartyFeature(theme.featureIdentifier) ? 'Installed theme' : 'Built in'}
                </span>
              </span>
              {active && <span className="text-info text-xs font-bold">Active</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default BaseThemePalette
