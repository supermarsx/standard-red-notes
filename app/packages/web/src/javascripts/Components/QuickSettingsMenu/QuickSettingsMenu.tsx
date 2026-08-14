import {
  ComponentArea,
  ComponentInterface,
  UIFeature,
  ContentType,
  PreferencesServiceEvent,
  ThemeFeatureDescription,
} from '@standardnotes/snjs'
import { NativeFeatureIdentifier } from '@standardnotes/features'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import FocusModeSwitch from './FocusModeSwitch'
import ThemesMenuButton from './ThemesMenuButton'
import { sortThemes } from '@/Utils/SortThemes'
import PanelSettingsSection from './PanelSettingsSection'
import Menu from '../Menu/Menu'
import MenuSwitchButtonItem from '../Menu/MenuSwitchButtonItem'
import MenuRadioButtonItem from '../Menu/MenuRadioButtonItem'
import { useApplication } from '../ApplicationProvider'
import { GetAllThemesUseCase } from '@standardnotes/ui-services'
import MenuSection from '../Menu/MenuSection'
import { loadCustomThemesState } from '../Preferences/Panes/Appearance/CustomThemes/CustomThemeManager'
import {
  selectBuiltInTheme,
  selectCustomTheme,
  STANDARD_RED_SWATCH,
} from '../Preferences/Panes/Appearance/ThemeSelection'

type MenuProps = {
  closeMenu: () => void
}

export function isStandardRedTheme(theme: UIFeature<ThemeFeatureDescription>): boolean {
  return theme.featureIdentifier === NativeFeatureIdentifier.TYPES.StandardRedTheme
}

export function excludeFirstClassStandardRed(
  themes: UIFeature<ThemeFeatureDescription>[],
): UIFeature<ThemeFeatureDescription>[] {
  return themes.filter((theme) => !isStandardRedTheme(theme))
}

export function isStandardRedSelectionActive(
  customThemeActive: boolean,
  activeBaseTheme?: UIFeature<ThemeFeatureDescription>,
): boolean {
  return !customThemeActive && (!activeBaseTheme || isStandardRedTheme(activeBaseTheme))
}

const QuickSettingsMenu: FunctionComponent<MenuProps> = ({ closeMenu }) => {
  const application = useApplication()

  const { focusModeEnabled, setFocusModeEnabled } = application.paneController
  const [themes, setThemes] = useState<UIFeature<ThemeFeatureDescription>[]>([])
  const [editorStackComponents, setEditorStackComponents] = useState<ComponentInterface[]>([])

  const activeThemes = application.componentManager.getActiveThemes()
  const activeBaseTheme = activeThemes.find((theme) => !theme.layerable)
  const customThemesState = loadCustomThemesState(application.preferences)
  const customThemeActive = customThemesState.selectedId !== null
  const defaultThemeOn = isStandardRedSelectionActive(customThemeActive, activeBaseTheme)

  const prefsButtonRef = useRef<HTMLButtonElement>(null)
  const defaultThemeButtonRef = useRef<HTMLButtonElement>(null)

  const reloadThemes = useCallback(() => {
    const usecase = new GetAllThemesUseCase(application.items)
    const { thirdParty, native } = usecase.execute({ excludeLayerable: false })
    setThemes(excludeFirstClassStandardRed([...thirdParty, ...native]).sort(sortThemes))
  }, [application])

  const reloadEditorStackComponents = useCallback(() => {
    const toggleableComponents = application.items
      .getDisplayableComponents()
      .filter(
        (component) =>
          !component.isTheme() &&
          [ComponentArea.EditorStack].includes(component.area) &&
          component.identifier !== NativeFeatureIdentifier.TYPES.DeprecatedFoldersComponent,
      )

    setEditorStackComponents(toggleableComponents)
  }, [application])

  useEffect(() => {
    if (!themes.length) {
      reloadThemes()
    }
  }, [reloadThemes, themes.length])

  useEffect(() => {
    const cleanupItemStream = application.items.streamItems(ContentType.TYPES.Theme, () => {
      reloadThemes()
    })

    return () => {
      cleanupItemStream()
    }
  }, [application, reloadThemes])

  useEffect(() => {
    return application.preferences.addEventObserver((event) => {
      if (event === PreferencesServiceEvent.LocalPreferencesChanged) {
        reloadThemes()
      }
    })
  }, [application, reloadThemes])

  useEffect(() => {
    const cleanupItemStream = application.items.streamItems(ContentType.TYPES.Component, () => {
      reloadEditorStackComponents()
    })

    return () => {
      cleanupItemStream()
    }
  }, [application, reloadEditorStackComponents])

  useEffect(() => {
    prefsButtonRef.current?.focus()
  }, [])

  const toggleEditorStackComponent = useCallback(
    (component: ComponentInterface) => {
      void application.componentManager.toggleComponent(component)
    },
    [application],
  )

  const toggleDefaultTheme = useCallback(() => {
    void selectBuiltInTheme(application)
  }, [application])

  return (
    <Menu a11yLabel="Quick settings menu">
      {editorStackComponents.length > 0 && (
        <MenuSection title="Tools">
          {editorStackComponents.map((component) => (
            <MenuSwitchButtonItem
              onChange={() => {
                toggleEditorStackComponent(component)
              }}
              checked={application.componentManager.isComponentActive(component)}
              key={component.uuid}
            >
              <Icon type="window" className="text-neutral mr-2" />
              {component.displayName}
            </MenuSwitchButtonItem>
          ))}
        </MenuSection>
      )}
      <MenuSection title="Appearance">
        <MenuRadioButtonItem checked={defaultThemeOn} onClick={toggleDefaultTheme} ref={defaultThemeButtonRef}>
          <span className="mr-auto">Standard Red</span>
          <span
            className="border-contrast h-5 w-5 rounded-full border"
            style={{ backgroundColor: STANDARD_RED_SWATCH }}
            aria-hidden="true"
          />
        </MenuRadioButtonItem>
        {themes.map((theme) => (
          <ThemesMenuButton
            uiFeature={theme}
            customThemeActive={customThemeActive}
            key={theme.uniqueIdentifier.value}
          />
        ))}
        {customThemesState.themes.map((theme) => {
          const active = customThemesState.selectedId === theme.id
          return (
            <MenuRadioButtonItem
              checked={active}
              onClick={() => selectCustomTheme(application, theme.id)}
              key={theme.id}
            >
              <span className={active ? 'mr-auto font-semibold' : 'mr-auto'}>{theme.name}</span>
              <span
                className="border-contrast h-5 w-5 rounded-full border"
                style={{ backgroundColor: theme.colors.accent }}
                aria-hidden="true"
              />
            </MenuRadioButtonItem>
          )
        })}
      </MenuSection>

      <FocusModeSwitch
        application={application}
        onToggle={setFocusModeEnabled}
        onClose={closeMenu}
        isEnabled={focusModeEnabled}
      />
      <PanelSettingsSection />
    </Menu>
  )
}

export default observer(QuickSettingsMenu)
