import { useEffect, useId, useRef, useState } from 'react'
import { ApplicationEvent } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { applyUiScale, normalizeUiScale, UI_SCALE_KEY } from '@/View/uiScale'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Title, Text } from '../../PreferencesComponents/Content'

export default function InterfaceScale() {
  const application = useApplication()
  const [value, setValue] = useState(() => normalizeUiScale(application.getPreference(UI_SCALE_KEY, 100)))
  const latest = useRef(value),
    saved = useRef(value)
  const [error, setError] = useState(false)
  const id = useId()
  useEffect(
    () =>
      application.addEventObserver(async () => {
        const next = normalizeUiScale(application.getPreference(UI_SCALE_KEY, 100))
        latest.current = next
        saved.current = next
        setValue(next)
      }, ApplicationEvent.PreferencesChanged),
    [application],
  )
  const preview = (next: number) => {
    latest.current = normalizeUiScale(next)
    setValue(latest.current)
    applyUiScale(latest.current)
  }
  const save = () => {
    const next = latest.current
    if (saved.current === next) {
      return
    }
    const previous = saved.current
    saved.current = next
    void application
      .setPreference(UI_SCALE_KEY, next)
      .then(() => setError(false))
      .catch(() => {
        saved.current = previous
        setError(true)
      })
  }
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Interface scale</Title>
        <Text>
          Resize menus, tabs, dialogs and interface spacing. At 100%, the app follows your browser’s normal text size.
        </Text>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label htmlFor={id} className="flex items-center gap-3 text-sm">
            UI scale <output htmlFor={id}>{value}%</output>
          </label>
          <input
            id={id}
            type="range"
            aria-label="Interface scale"
            aria-valuetext={`${value}%`}
            min={75}
            max={150}
            step={5}
            value={value}
            onChange={(event) => preview(Number(event.target.value))}
            onPointerUp={save}
            onKeyUp={save}
            onBlur={save}
          />
          <div className="flex flex-wrap gap-1 sm:col-span-2">
            {[80, 90, 100, 110, 125, 150].map((scale) => (
              <button
                key={scale}
                type="button"
                aria-pressed={value === scale}
                className="border-border bg-default text-text hover:bg-contrast rounded border px-2 py-1 text-xs"
                onClick={() => {
                  preview(scale)
                  save()
                }}
              >
                {scale}%
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-info justify-self-start text-sm underline"
            onClick={() => {
              preview(100)
              save()
            }}
          >
            Reset to 100%
          </button>
        </div>
        {error && (
          <p role="alert" className="text-danger mt-2 text-sm">
            The scale is previewed, but could not be saved. Try again.
          </p>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
