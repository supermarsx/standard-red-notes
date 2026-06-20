import { FunctionComponent, useCallback, useMemo, useReducer, useState } from 'react'
import { Subtitle, Text, SmallText } from '@/Components/Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import {
  CustomTheme,
  CustomThemeColors,
  CustomThemesAction,
  CustomThemesState,
  DefaultCustomThemeColors,
  customThemesReducer,
  generateCustomThemeVariables,
  hasReadableContrast,
} from './CustomTheme'
import { applyCustomThemeFromState, loadCustomThemesState, saveCustomThemesState } from './CustomThemeManager'

type ColorField = {
  key: keyof CustomThemeColors
  label: string
  hint: string
}

const COLOR_FIELDS: ColorField[] = [
  { key: 'accent', label: 'Accent color', hint: 'Buttons, links and highlights' },
  { key: 'background', label: 'Background', hint: 'Main app background' },
  { key: 'foreground', label: 'Text', hint: 'Primary text color' },
  { key: 'contrast', label: 'Contrast surface', hint: 'Panels and selected rows' },
]

const dispatchWithPersist = (reducer: (state: CustomThemesState, action: CustomThemesAction) => CustomThemesState) => {
  return (state: CustomThemesState, action: CustomThemesAction): CustomThemesState => {
    const next = reducer(state, action)
    if (next !== state) {
      saveCustomThemesState(next)
      applyCustomThemeFromState(next)
    }
    return next
  }
}

type EditorMode = { kind: 'create' } | { kind: 'edit'; id: string } | null

const ThemePreview: FunctionComponent<{ colors: CustomThemeColors }> = ({ colors }) => {
  const variables = useMemo(() => generateCustomThemeVariables(colors), [colors])
  return (
    <div
      className="overflow-hidden rounded border border-border"
      style={{ background: colors.background, color: colors.foreground }}
    >
      <div className="flex items-center justify-between px-3 py-2" style={{ background: colors.contrast }}>
        <span className="text-sm font-bold">Preview</span>
        <span
          className="rounded px-2 py-0.5 text-xs font-bold"
          style={{ background: colors.accent, color: variables['--sn-stylekit-info-contrast-color'] }}
        >
          Accent
        </span>
      </div>
      <div className="px-3 py-2">
        <div className="text-sm">The quick brown fox jumps over the lazy dog.</div>
        <a className="text-sm underline" style={{ color: colors.accent }}>
          A sample link
        </a>
      </div>
    </div>
  )
}

const ColorInput: FunctionComponent<{
  field: ColorField
  value: string
  onChange: (value: string) => void
}> = ({ field, value, onChange }) => (
  <label className="flex items-center justify-between gap-3 py-1">
    <span className="flex flex-col">
      <span className="text-sm font-medium">{field.label}</span>
      <span className="text-xs text-passive-0">{field.hint}</span>
    </span>
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs text-passive-0">{value}</span>
      <input
        type="color"
        aria-label={field.label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0"
      />
    </span>
  </label>
)

const ThemeEditor: FunctionComponent<{
  initialName: string
  initialColors: CustomThemeColors
  submitLabel: string
  onSubmit: (name: string, colors: CustomThemeColors) => void
  onCancel: () => void
}> = ({ initialName, initialColors, submitLabel, onSubmit, onCancel }) => {
  const [name, setName] = useState(initialName)
  const [colors, setColors] = useState<CustomThemeColors>(initialColors)

  const setColor = useCallback((key: keyof CustomThemeColors, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }))
  }, [])

  const readable = hasReadableContrast(colors.foreground, colors.background)

  return (
    <div className="mt-3 rounded border border-border p-3">
      <label className="mb-3 flex flex-col gap-1">
        <span className="text-sm font-medium">Theme name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My custom theme"
          className="rounded border border-border bg-default px-2 py-1.5 text-sm text-text"
        />
      </label>

      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          {COLOR_FIELDS.map((field) => (
            <ColorInput
              key={field.key}
              field={field}
              value={colors[field.key]}
              onChange={(value) => setColor(field.key, value)}
            />
          ))}
        </div>
        <div className="mt-3 md:mt-0">
          <ThemePreview colors={colors} />
          {!readable && (
            <SmallText className="mt-2 text-warning">
              Low contrast between text and background — this may be hard to read.
            </SmallText>
          )}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button primary small label={submitLabel} onClick={() => onSubmit(name, colors)} />
        <Button small label="Cancel" onClick={onCancel} />
      </div>
    </div>
  )
}

const CustomThemesSection: FunctionComponent = () => {
  const persistingReducer = useMemo(() => dispatchWithPersist(customThemesReducer), [])
  const [state, dispatch] = useReducer(persistingReducer, undefined, loadCustomThemesState)
  const [editorMode, setEditorMode] = useState<EditorMode>(null)

  const editingTheme: CustomTheme | undefined =
    editorMode?.kind === 'edit' ? state.themes.find((theme) => theme.id === editorMode.id) : undefined

  const handleCreate = useCallback(
    (name: string, colors: CustomThemeColors) => {
      dispatch({ type: 'add', name, colors, select: true })
      setEditorMode(null)
    },
    [dispatch],
  )

  const handleEdit = useCallback(
    (id: string, name: string, colors: CustomThemeColors) => {
      dispatch({ type: 'update', id, name, colors })
      setEditorMode(null)
    },
    [dispatch],
  )

  const handleDelete = useCallback(
    (theme: CustomTheme) => {
      if (window.confirm(`Delete the custom theme "${theme.name}"?`)) {
        dispatch({ type: 'delete', id: theme.id })
        if (editorMode?.kind === 'edit' && editorMode.id === theme.id) {
          setEditorMode(null)
        }
      }
    },
    [dispatch, editorMode],
  )

  const handleSelect = useCallback(
    (id: string | null) => {
      dispatch({ type: 'select', id })
    },
    [dispatch],
  )

  return (
    <>
      <HorizontalSeparator classes="my-4" />
      <div>
        <Subtitle>Custom themes</Subtitle>
        <Text>Create your own theme by picking an accent color and a few key colors. Applies live.</Text>

        <div className="mt-3 flex flex-col gap-2">
          {state.themes.length === 0 && <SmallText className="text-passive-0">No custom themes yet.</SmallText>}
          {state.themes.map((theme) => {
            const isSelected = state.selectedId === theme.id
            return (
              <div
                key={theme.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <span
                    className="h-5 w-5 flex-shrink-0 rounded-full border border-border"
                    style={{ background: theme.colors.accent }}
                    aria-hidden
                  />
                  <span className="truncate text-sm font-medium">{theme.name}</span>
                  {isSelected && <span className="text-xs font-bold text-info">Active</span>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Button
                    small
                    colorStyle={isSelected ? 'info' : 'default'}
                    label={isSelected ? 'Applied' : 'Apply'}
                    disabled={isSelected}
                    onClick={() => handleSelect(theme.id)}
                  />
                  <Button small label="Edit" onClick={() => setEditorMode({ kind: 'edit', id: theme.id })} />
                  <Button small colorStyle="danger" label="Delete" onClick={() => handleDelete(theme)} />
                </div>
              </div>
            )
          })}
        </div>

        {state.selectedId !== null && (
          <div className="mt-2">
            <Button small label="Use a built-in theme (remove custom)" onClick={() => handleSelect(null)} />
          </div>
        )}

        {editorMode === null && (
          <div className="mt-3">
            <Button small label="Create custom theme" onClick={() => setEditorMode({ kind: 'create' })} />
          </div>
        )}

        {editorMode?.kind === 'create' && (
          <ThemeEditor
            initialName=""
            initialColors={DefaultCustomThemeColors}
            submitLabel="Create"
            onSubmit={handleCreate}
            onCancel={() => setEditorMode(null)}
          />
        )}

        {editorMode?.kind === 'edit' && editingTheme && (
          <ThemeEditor
            initialName={editingTheme.name}
            initialColors={editingTheme.colors}
            submitLabel="Save changes"
            onSubmit={(name, colors) => handleEdit(editingTheme.id, name, colors)}
            onCancel={() => setEditorMode(null)}
          />
        )}
      </div>
    </>
  )
}

export default CustomThemesSection
