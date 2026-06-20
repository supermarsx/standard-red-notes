import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ToastType, addToast } from '@standardnotes/toast'
import { classNames } from '@standardnotes/snjs'
import Icon from '../Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { loadDictationSettings } from '@/Assistant/dictationSettings'
import { getSpeechRecognitionCtor } from '@/Assistant/transcription'
import { startDictation, DictationHandle, DictationState } from '@/Assistant/dictation'
import { insertTextIntoActiveEditor } from '@/Assistant/insertEditorText'

/**
 * Toolbar mic toggle for live "type by speaking" dictation. It renders nothing unless
 * the user has opted in (dictationEnabled, default OFF) AND the browser supports
 * SpeechRecognition (Chromium-only). On click it starts/stops live recognition,
 * inserting each finalized segment at the editor caret. Default OFF and self-hiding so
 * the mic is never auto-enabled.
 */
const DictationButton = () => {
  // Snapshot the opt-in once on mount; the setting lives in localStorage and is
  // toggled from preferences (a remount surface). Re-read on focus so toggling the
  // preference reflects without a full reload.
  const [enabled, setEnabled] = useState(() => loadDictationSettings().dictationEnabled)
  const [supported] = useState(() => getSpeechRecognitionCtor() !== undefined)
  const [state, setState] = useState<DictationState>('idle')
  const handleRef = useRef<DictationHandle | null>(null)

  useEffect(() => {
    const refresh = () => setEnabled(loadDictationSettings().dictationEnabled)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // Stop listening if the button unmounts (note switch / pane close).
  useEffect(() => {
    return () => {
      handleRef.current?.stop()
      handleRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    handleRef.current?.stop()
    handleRef.current = null
    setState('idle')
  }, [])

  const toggle = useCallback(() => {
    if (state === 'listening') {
      stop()
      return
    }
    const { language } = loadDictationSettings()
    handleRef.current = startDictation({
      language,
      onFinalText: (text) => {
        const inserted = insertTextIntoActiveEditor(text)
        if (!inserted) {
          addToast({
            type: ToastType.Error,
            message: 'Click into the note text first so dictation can insert there.',
          })
        }
      },
      onState: setState,
      onError: (message) => {
        addToast({ type: ToastType.Error, message })
        handleRef.current = null
      },
    })
  }, [state, stop])

  if (!enabled || !supported) {
    return null
  }

  const listening = state === 'listening'

  return (
    <StyledTooltip label={listening ? 'Stop dictation' : 'Dictate (type by speaking)'}>
      <button
        className={classNames(
          'flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-solid border-transparent hover:bg-contrast',
          listening ? 'bg-danger text-danger-contrast' : 'text-neutral',
        )}
        aria-label={listening ? 'Stop dictation' : 'Start dictation'}
        aria-pressed={listening}
        onClick={toggle}
      >
        <Icon type={listening ? 'close' : 'file-music'} size="custom" className="h-5 w-5" />
      </button>
    </StyledTooltip>
  )
}

export default observer(DictationButton)
