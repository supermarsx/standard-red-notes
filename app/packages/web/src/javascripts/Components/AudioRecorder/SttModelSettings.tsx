import { useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text } from '../Preferences/PreferencesComponents/Content'
import {
  DictationSettings,
  loadDictationSettings,
  saveDictationSettings,
} from '@/Assistant/dictationSettings'
import { fetchAvailableSttModels, KNOWN_STT_MODELS } from '@/Assistant/transcription'

// Sentinel option value for the free-text "Custom…" choice in the model dropdown.
// Empty string is reserved for "Server default" (send no model), so the custom
// sentinel must be a value no real model id can collide with.
const CUSTOM_OPTION = '__custom__'

/**
 * Self-contained Speech-to-text MODEL selector for the Assistant preferences pane.
 *
 * Behavior:
 *  - On mount it BEST-EFFORT fetches the STT models the server advertises
 *    (GET /v1/assistant/transcription/models). Detection is silent: a failure or an
 *    empty list simply means "no detected list" and never shows an error.
 *  - When models are detected, it renders a DROPDOWN with:
 *      "Server default" (empty value, omits the model param),
 *      each detected model id,
 *      "Custom…" which reveals a free-text input.
 *  - When NOTHING is detected, it gracefully falls back to a free-text model input
 *    plus the "Server default" hint (leave empty).
 *
 * The selected model is persisted in the device-local dictation settings
 * (localStorage). Empty value => the transcription request omits `model` so the
 * server's own default model is used.
 */
const SttModelSettings = ({ application }: { application: WebApplication }) => {
  const [dictation, setDictation] = useState<DictationSettings>(() => loadDictationSettings())
  const [detected, setDetected] = useState<string[]>([])
  const [detecting, setDetecting] = useState(true)

  const updateModel = useCallback((value: string) => {
    setDictation((prev) => {
      const next = { ...prev, sttModel: value }
      saveDictationSettings(next)
      return next
    })
  }, [])

  // Best-effort detection of server-advertised STT models when the section mounts.
  useEffect(() => {
    let cancelled = false
    setDetecting(true)
    fetchAvailableSttModels(application)
      .then((models) => {
        if (!cancelled) {
          setDetected(models)
        }
      })
      .catch(() => {
        /* detection is best-effort; never surface an error */
      })
      .finally(() => {
        if (!cancelled) {
          setDetecting(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [application])

  // The dropdown options: detected list (if any), unioned with any common STT model
  // names and the user's currently-saved id so it always appears as a real option
  // rather than collapsing into "Custom…".
  const options = useMemo(() => {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (id: string) => {
      const trimmed = id.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        out.push(trimmed)
      }
    }
    detected.forEach(push)
    // If the server advertised nothing, still offer the well-known ids as hints.
    if (detected.length === 0) {
      KNOWN_STT_MODELS.forEach(push)
    }
    if (dictation.sttModel.trim()) {
      push(dictation.sttModel)
    }
    return out
  }, [detected, dictation.sttModel])

  const hasDropdown = options.length > 0
  const currentModel = dictation.sttModel.trim()
  // The dropdown reflects: empty -> Server default; a known option -> that option;
  // a non-listed non-empty id -> "Custom…" (with the free-text input revealed).
  const isCustom = currentModel !== '' && !options.includes(currentModel)
  const selectValue = currentModel === '' ? '' : isCustom ? CUSTOM_OPTION : currentModel

  const onSelectChange = useCallback(
    (value: string) => {
      if (value === CUSTOM_OPTION) {
        // Switch into custom mode; keep any existing custom text, else start blank
        // so the free-text input is editable (empty here means "typing a custom id").
        updateModel(currentModel && !options.includes(currentModel) ? currentModel : ' ')
        return
      }
      updateModel(value)
    },
    [updateModel, currentModel, options],
  )

  return (
    <>
      <Subtitle>Speech-to-text model</Subtitle>
      <Text>
        Model id sent to the transcription endpoint (e.g. whisper-1, gpt-4o-transcribe). Choose “Server default” to
        send no model id and let the server pick. Direct mode only.
        {detected.length > 0 && ' Models below were detected from your server.'}
      </Text>

      {hasDropdown ? (
        <>
          <select
            className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
            value={selectValue}
            onChange={(event) => onSelectChange(event.target.value)}
          >
            <option value="">Server default</option>
            {options.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            <option value={CUSTOM_OPTION}>Custom…</option>
          </select>

          {selectValue === CUSTOM_OPTION && (
            <input
              className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="text"
              value={currentModel === '' ? '' : currentModel}
              placeholder="custom model id"
              onChange={(event) => updateModel(event.target.value)}
            />
          )}
        </>
      ) : (
        <input
          className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
          type="text"
          value={dictation.sttModel}
          placeholder="(leave empty for server default)"
          onChange={(event) => updateModel(event.target.value)}
        />
      )}

      {detecting && <Text className="mt-1 text-passive-1">Detecting available models…</Text>}
    </>
  )
}

export default observer(SttModelSettings)
