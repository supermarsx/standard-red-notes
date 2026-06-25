import { useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'
import PreferencesGroup from '../Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../Preferences/PreferencesComponents/PreferencesSegment'
import { Title, Subtitle, Text } from '../Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { NARRATION_STYLES } from '@/Assistant/narration'
import {
  clampRate,
  loadNarrationSettings,
  NarrationSettings as NarrationSettingsType,
  NarrationStyleSetting,
  saveNarrationSettings,
} from '@/Assistant/narrationSettings'
import { COMMON_LANGUAGES } from '@/Assistant/languages'
import { getTtsAvailability, listWebSpeechVoices } from '@/Assistant/tts'

/**
 * Self-contained preferences section for narration / text-to-speech defaults,
 * including the default language/dialect and clarification. Drop it into the
 * Assistant preferences pane (it renders its own PreferencesGroup so it slots in
 * between the pane's other groups). Settings persist to device-local localStorage.
 */
const NarrationSettings = ({ application }: { application: WebApplication }) => {
  const [narration, setNarration] = useState<NarrationSettingsType>(() => loadNarrationSettings())
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listWebSpeechVoices())
  const ttsAvailability = useMemo(() => getTtsAvailability(application), [application])

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return
    }
    const update = () => setVoices(listWebSpeechVoices())
    update()
    window.speechSynthesis.onvoiceschanged = update
    return () => {
      window.speechSynthesis.onvoiceschanged = null
    }
  }, [])

  const updateNarration = useCallback((patch: Partial<NarrationSettingsType>) => {
    setNarration((prev) => {
      const next = { ...prev, ...patch }
      saveNarrationSettings(next)
      return next
    })
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Narration &amp; text-to-speech</Title>
        <Text>
          Narrate a note from its options menu: the AI rewrites it into clean, listenable text and a player reads it
          aloud. Generating narration sends the note&rsquo;s content to your configured AI provider.
        </Text>
        <Text className="mt-2 text-passive-1">
          {ttsAvailability.modelAvailable
            ? 'Playback prefers model voices via your Direct endpoint’s /audio/speech route (sending the narration text there), and falls back to your device’s built-in voices.'
            : 'Playback uses your device’s built-in voices (browser text-to-speech) — no network and no key required. Model voices need Direct mode with a base URL.'}
        </Text>

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Default narration style</Subtitle>
        <Text>Used when you narrate a note. Choose “Ask each time” to pick a style on every narration.</Text>
        <select
          className="mt-2 rounded border border-border bg-default px-2 py-1.5 text-sm"
          value={narration.defaultStyle}
          onChange={(event) => updateNarration({ defaultStyle: event.target.value as NarrationStyleSetting })}
        >
          <option value="ask">Ask each time</option>
          {NARRATION_STYLES.map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </select>

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Default language / dialect</Subtitle>
        <Text>
          Default voice language/accent hint used when you narrate (e.g. “British English”, “es-ES”). You can override
          it per narration. Any free text or a language code is accepted. Leave empty to let the voice decide.
        </Text>
        <input
          className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
          type="text"
          list="narration-settings-language-list"
          value={narration.language}
          placeholder="(let the voice decide)"
          onChange={(event) => updateNarration({ language: event.target.value })}
        />
        <datalist id="narration-settings-language-list">
          {COMMON_LANGUAGES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Default clarification</Subtitle>
        <Text>
          Optional default delivery instruction sent to a model voice (e.g. “speak slowly and clearly”). Ignored by
          device voices, which cannot follow free-text instructions. Override it per narration.
        </Text>
        <input
          className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
          type="text"
          value={narration.clarification}
          placeholder="e.g. speak slowly and clearly"
          onChange={(event) => updateNarration({ clarification: event.target.value })}
        />

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Device voice</Subtitle>
        <Text>Voice used for browser text-to-speech. Available voices depend on your OS and browser.</Text>
        {voices.length > 0 ? (
          <select
            className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
            value={narration.voiceURI}
            onChange={(event) => updateNarration({ voiceURI: event.target.value })}
          >
            <option value="">Browser default</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
        ) : (
          <Text className="mt-2 text-passive-1">No device voices detected yet.</Text>
        )}

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Model voice</Subtitle>
        <Text>
          Voice name sent to a model speech endpoint when one is configured (e.g. OpenAI&rsquo;s alloy, echo, fable,
          onyx, nova, shimmer). Ignored when using device voices.
        </Text>
        <input
          className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
          type="text"
          value={narration.modelVoice}
          placeholder="alloy"
          onChange={(event) => updateNarration({ modelVoice: event.target.value })}
        />

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Speaking speed: {narration.rate.toFixed(1)}×</Subtitle>
        <Text>Playback rate for device-voice narration. 1× is normal.</Text>
        <input
          className="mt-2 w-full"
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={narration.rate}
          onChange={(event) => updateNarration({ rate: clampRate(Number(event.target.value)) })}
        />
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(NarrationSettings)
