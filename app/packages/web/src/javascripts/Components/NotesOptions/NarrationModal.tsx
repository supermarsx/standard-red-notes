import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
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
import {
  getTtsAvailability,
  listWebSpeechVoices,
  playNarration,
  TtsHandle,
  TtsState,
} from '@/Assistant/tts'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

const NarrationModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
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

  // Stop any in-flight audio/generation when the modal unmounts.
  useEffect(() => {
    return () => {
      handleRef.current?.stop()
      abortRef.current?.abort()
    }
  }, [])

  const persist = useCallback((next: NarrationSettings) => {
    setSettings(next)
    saveNarrationSettings(next)
  }, [])

  const stopPlayback = useCallback(() => {
    handleRef.current?.stop()
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
      handleRef.current = playNarration(application, {
        text,
        voiceURI: settings.voiceURI,
        rate: settings.rate,
        modelVoice: settings.modelVoice,
        onState: setTtsState,
        onError: (message) => setTtsError(message),
      })
    },
    [application, settings.voiceURI, settings.rate, settings.modelVoice, stopPlayback],
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
          onClick: () => {
            stopPlayback()
            close()
          },
          mobileSlot: 'left',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* Data-exposure notice — same pattern as the Assistant preferences pane. */}
        <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
          <div className="font-semibold text-warning">Narration sends note content to an AI</div>
          <p className="mt-1">
            Generating narration sends this note&rsquo;s text to the AI provider you configured. If model voices are
            active, the narration text is also sent to your speech endpoint. Device-voice playback stays local.
          </p>
        </div>

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

        {/* Generate / raw note actions */}
        <div className="flex flex-wrap gap-2">
          <button
            className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
            onClick={() => void handleGenerate()}
            disabled={!aiAvailability.available || generating}
          >
            <Icon type="dashboard" size="small" />
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
              <Icon type="forward-ios" size="small" />
              Play
            </button>
            <button
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => (isPaused ? handleRef.current?.resume() : handleRef.current?.pause())}
              disabled={ttsState === 'idle' || ttsState === 'ended' || ttsState === 'error'}
            >
              <Icon type={isPaused ? 'forward-ios' : 'menu-close'} size="small" />
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={stopPlayback}
              disabled={ttsState === 'idle'}
            >
              <Icon type="close" size="small" />
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

const NarrationModal = ({ application, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[36rem]">
      <NarrationModalContent application={application} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(NarrationModal)
