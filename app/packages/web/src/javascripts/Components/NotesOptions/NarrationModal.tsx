import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import { FilesController } from '@/Controllers/FilesController'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import Icon from '../Icon/Icon'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import {
  generateNarration,
  getNarrationStyle,
  NARRATION_STYLES,
  NarrationStyleId,
  notePlaintext,
} from '@/Assistant/narration'
import {
  loadNarrationSettings,
  NarrationSettings,
  saveNarrationSettings,
  clampRate,
} from '@/Assistant/narrationSettings'
import { COMMON_LANGUAGES } from '@/Assistant/languages'
import { saveNarrationToNote } from '@/Assistant/narrationAudio'
import { narrationPlayerStore } from '../Narration/NarrationPlayerStore'
import {
  getTtsAvailability,
  listWebSpeechVoices,
  playNarration,
  TtsHandle,
  TtsState,
} from '@/Assistant/tts'

type Props = {
  application: WebApplication
  filesController: FilesController
  note: SNNote
  isOpen: boolean
  close: () => void
}

const NarrationModalContent = observer(({ application, filesController, note, close }: Omit<Props, 'isOpen'>) => {
  const [settings, setSettings] = useState<NarrationSettings>(() => loadNarrationSettings())
  const ttsAvailability = useMemo(() => getTtsAvailability(application), [application])
  const aiAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  const rawText = useMemo(() => notePlaintext(note.text ?? '', note.noteType), [note])

  // Whether to ask for a style each time, or use the saved default.
  const askEachTime = settings.defaultStyle === 'ask'
  const [styleId, setStyleId] = useState<NarrationStyleId>(() =>
    askEachTime ? NARRATION_STYLES[0].id : (settings.defaultStyle as NarrationStyleId),
  )

  const [narration, setNarration] = useState<string>('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listWebSpeechVoices())
  const [ttsState, setTtsState] = useState<TtsState>('idle')
  const [ttsError, setTtsError] = useState<string | null>(null)
  const handleRef = useRef<TtsHandle | null>(null)

  // Per-narration language/dialect + clarification overrides. Seeded from the saved
  // defaults; editing them here does not change the saved default.
  const [language, setLanguage] = useState<string>(() => settings.language)
  const [clarification, setClarification] = useState<string>(() => settings.clarification)

  // Web Speech voices often load asynchronously.
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

  // Abort any in-flight GENERATION when the modal unmounts. Playback is intentionally
  // NOT stopped here: it is owned by the app-wide floating player so it survives the
  // dialog closing. The user stops it from the floating player's close button.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const persist = useCallback((next: NarrationSettings) => {
    setSettings(next)
    saveNarrationSettings(next)
  }, [])

  const stopPlayback = useCallback(() => {
    // Dismiss the floating player, which owns the handle and stops it.
    narrationPlayerStore.dismiss()
    handleRef.current = null
    setTtsState('idle')
  }, [])

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) {
        return
      }
      stopPlayback()
      setTtsError(null)
      const langLabel = language.trim()
      const handle = playNarration(application, {
        text,
        voiceURI: settings.voiceURI,
        rate: settings.rate,
        modelVoice: settings.modelVoice,
        language: langLabel,
        clarification: clarification.trim(),
        onState: (state) => {
          setTtsState(state)
          narrationPlayerStore.setState(state)
        },
        onError: (message) => {
          setTtsError(message)
          narrationPlayerStore.setError(message)
        },
        // Persist the produced narration audio to the note (model backend only).
        onAudioReady: (blob) => {
          void saveNarrationToNote(filesController, note, blob, {
            voice: settings.modelVoice,
            language: langLabel,
          }).then((result) => {
            if (result.attached) {
              addToast({ type: ToastType.Success, message: 'Narration audio saved to note.' })
            }
          })
        },
      })
      handleRef.current = handle
      // Drive the app-wide floating player from this narration.
      narrationPlayerStore.start(handle, {
        noteTitle: note.title ?? '',
        backend: handle.backend,
        language: langLabel,
      })
    },
    [
      application,
      filesController,
      note,
      settings.voiceURI,
      settings.rate,
      settings.modelVoice,
      language,
      clarification,
      stopPlayback,
    ],
  )

  const handleGenerate = useCallback(async () => {
    if (!aiAvailability.available) {
      return
    }
    stopPlayback()
    setGenerating(true)
    setGenError(null)
    setNarration('')
    setTruncated(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await generateNarration(application, styleId, rawText, {
        signal: controller.signal,
        onDelta: (full) => setNarration(full),
      })
      setNarration(result.narration)
      setTruncated(result.truncated)
    } catch (error) {
      setGenError(error instanceof Error ? error.message : String(error))
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }, [aiAvailability.available, application, rawText, stopPlayback, styleId])

  const copyNarration = useCallback(async () => {
    try {
      await navigator?.clipboard?.writeText(narration || rawText)
      addToast({ type: ToastType.Success, message: 'Narration copied to clipboard.' })
    } catch {
      addToast({ type: ToastType.Error, message: 'Could not copy to clipboard.' })
    }
  }, [narration, rawText])

  const isPlaying = ttsState === 'playing' || ttsState === 'loading'
  const isPaused = ttsState === 'paused'
  const activeBackend = handleRef.current?.backend

  const ttsModeLabel = ttsAvailability.modelAvailable
    ? 'Model voice (sends narration text to your AI endpoint), with device-voice fallback'
    : 'Device voice (browser text-to-speech, no network)'

  return (
    <Modal
      title="Narrate note"
      className="p-4"
      close={close}
      actions={[
        {
          label: 'Close',
          type: 'cancel',
          // Leave playback running — the floating player keeps it controllable after
          // the dialog closes. The user stops it from the floating player.
          onClick: () => close(),
          mobileSlot: 'left',
        },
      ]}
    >
      <div className="flex flex-col gap-3">
        {/* Data-exposure notice — compact one-liner. */}
        <p className="rounded border border-warning bg-warning-faded px-2.5 py-1.5 text-xs text-warning">
          Generating narration (and model voices) sends this note&rsquo;s text to your configured AI provider.
          Device-voice playback stays local.
        </p>

        {/* Style selection */}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold">Narration style</label>
          <select
            className="rounded border border-border bg-default px-2 py-1.5 text-sm"
            value={styleId}
            onChange={(event) => setStyleId(event.target.value as NarrationStyleId)}
          >
            {NARRATION_STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-passive-0">{getNarrationStyle(styleId).description}</span>
        </div>

        {/* Language / dialect + free-text clarification (override the saved default). */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label className="text-sm font-semibold">Language / dialect</label>
            <input
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="text"
              list="narration-language-list"
              value={language}
              placeholder="e.g. British English, es-ES (optional)"
              onChange={(event) => setLanguage(event.target.value)}
            />
            <datalist id="narration-language-list">
              {COMMON_LANGUAGES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span className="text-xs text-passive-0">
              Hints the voice/accent. Any free text or a language code is accepted.
            </span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label className="text-sm font-semibold">Clarification (optional)</label>
            <input
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="text"
              value={clarification}
              placeholder="e.g. speak slowly and clearly"
              onChange={(event) => setClarification(event.target.value)}
            />
            <span className="text-xs text-passive-0">Delivery instruction sent to a model voice.</span>
          </div>
        </div>

        {/* Generate / raw note actions */}
        <div className="flex flex-wrap gap-2">
          <button
            className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
            onClick={() => void handleGenerate()}
            disabled={!aiAvailability.available || generating}
          >
            <Icon type="sparkle" size="small" />
            {generating ? 'Generating…' : 'Rewrite with AI'}
          </button>
          <button
            className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={() => speak(rawText)}
            disabled={!rawText.trim()}
            title="Skip the AI rewrite and read the note text as-is"
          >
            <Icon type="file-music" size="small" />
            Read raw note
          </button>
        </div>

        {!aiAvailability.available && (
          <p className="text-xs text-passive-0">{aiAvailability.reason}</p>
        )}
        {genError && <p className="text-sm text-danger">Could not generate narration: {genError}</p>}

        {/* Narration text view */}
        {(narration || generating) && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold">Narration text</label>
              <button className="text-xs text-info hover:underline" onClick={() => void copyNarration()}>
                Copy
              </button>
            </div>
            <textarea
              className="max-h-48 w-full resize-y rounded border border-border bg-default px-2 py-1.5 text-sm"
              rows={6}
              value={narration}
              onChange={(event) => setNarration(event.target.value)}
              placeholder={generating ? 'Generating narration…' : ''}
            />
            {truncated && (
              <span className="text-xs text-warning">
                The note was longer than the narration limit and was truncated.
              </span>
            )}
          </div>
        )}

        {/* Player */}
        <div className="flex flex-col gap-3 rounded border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
              onClick={() => speak(narration || rawText)}
              disabled={!(narration || rawText).trim() || isPlaying}
            >
              <Icon type="play" size="small" />
              Play
            </button>
            <button
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => (isPaused ? handleRef.current?.resume() : handleRef.current?.pause())}
              disabled={ttsState === 'idle' || ttsState === 'ended' || ttsState === 'error'}
            >
              <Icon type={isPaused ? 'play' : 'pause'} size="small" />
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={stopPlayback}
              disabled={ttsState === 'idle'}
            >
              <Icon type="stop" size="small" />
              Stop
            </button>
            <span className="ml-auto text-xs text-passive-0">
              {ttsState === 'loading' ? 'Loading audio…' : activeBackend === 'model' ? 'Model voice' : 'Device voice'}
            </span>
          </div>

          <p className="text-xs text-passive-0">{ttsModeLabel}</p>
          {ttsError && <p className="text-xs text-danger">{ttsError}</p>}

          {/* Voice + speed controls */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {voices.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-xs font-semibold">Device voice</label>
                <select
                  className="w-full rounded border border-border bg-default px-2 py-1 text-sm"
                  value={settings.voiceURI}
                  onChange={(event) => persist({ ...settings, voiceURI: event.target.value })}
                >
                  <option value="">Browser default</option>
                  {voices.map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name} ({voice.lang})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold">Speed: {settings.rate.toFixed(1)}×</label>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={settings.rate}
                onChange={(event) => persist({ ...settings, rate: clampRate(Number(event.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
})

const NarrationModal = ({ application, filesController, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[36rem]">
      <NarrationModalContent
        application={application}
        filesController={filesController}
        note={note}
        close={close}
      />
    </ModalOverlay>
  )
}

export default observer(NarrationModal)
