import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import { FilesController } from '@/Controllers/FilesController'
import { AudioRecorder } from '@/Controllers/Moments/AudioRecorder'
import { formatDateAndTimeForNote } from '@/Utils/DateUtils'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import Icon from '../Icon/Icon'
import {
  getSttAvailability,
  decideSttBackend,
  transcribeWithModel,
  inferFileName,
  resolveTranscriptionModel,
} from '@/Assistant/transcription'
import { insertTextIntoActiveEditor } from '@/Assistant/insertEditorText'

type Props = {
  application: WebApplication
  filesController: FilesController
  note: SNNote
  isOpen: boolean
  close: () => void
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function extensionFor(blob: Blob): string {
  return inferFileName(blob).replace(/^recording/, '')
}

const AudioRecorderContent = observer(
  ({ application, filesController, note, close }: Omit<Props, 'isOpen'>) => {
    const sttAvailability = useMemo(() => getSttAvailability(application), [application])
    const sttDecision = useMemo(() => decideSttBackend(sttAvailability), [sttAvailability])
    // Resolved STT model id; empty string means the request omits `model` and the
    // server's own default model is used.
    const transcriptionModel = useMemo(() => resolveTranscriptionModel(application), [application])

    const recorderRef = useRef<AudioRecorder | null>(null)
    const [supported] = useState(() => AudioRecorder.isSupported())
    const [phase, setPhase] = useState<'idle' | 'recording' | 'paused' | 'recorded'>('idle')
    const [elapsed, setElapsed] = useState(0)
    const [recorded, setRecorded] = useState<Blob | null>(null)
    const [permissionError, setPermissionError] = useState<string | null>(null)

    const [transcribing, setTranscribing] = useState(false)
    const [transcript, setTranscript] = useState('')
    const [transcribeError, setTranscribeError] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)

    const recordedUrl = useMemo(() => (recorded ? URL.createObjectURL(recorded) : null), [recorded])

    useEffect(() => {
      return () => {
        if (recordedUrl) {
          URL.revokeObjectURL(recordedUrl)
        }
      }
    }, [recordedUrl])

    // Tick the timer while recording.
    useEffect(() => {
      if (phase !== 'recording') {
        return
      }
      const interval = setInterval(() => {
        setElapsed(recorderRef.current?.elapsedMs() ?? 0)
      }, 250)
      return () => clearInterval(interval)
    }, [phase])

    // Release the mic if the modal closes mid-recording.
    useEffect(() => {
      return () => {
        recorderRef.current?.cancel()
        abortRef.current?.abort()
      }
    }, [])

    const startRecording = useCallback(async () => {
      setPermissionError(null)
      setRecorded(null)
      setTranscript('')
      setTranscribeError(null)
      const recorder = new AudioRecorder()
      try {
        await recorder.initialize()
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Microphone permission was denied. Allow mic access to record.'
            : error instanceof Error
              ? error.message
              : String(error)
        setPermissionError(message)
        return
      }
      recorderRef.current = recorder
      recorder.start()
      setElapsed(0)
      setPhase('recording')
    }, [])

    const pauseRecording = useCallback(() => {
      recorderRef.current?.pause()
      setPhase('paused')
    }, [])

    const resumeRecording = useCallback(() => {
      recorderRef.current?.resume()
      setPhase('recording')
    }, [])

    const stopRecording = useCallback(async () => {
      const recorder = recorderRef.current
      if (!recorder) {
        return
      }
      const blob = await recorder.stop()
      recorderRef.current = null
      setRecorded(blob)
      setPhase('recorded')
    }, [])

    const discard = useCallback(() => {
      recorderRef.current?.cancel()
      recorderRef.current = null
      setRecorded(null)
      setTranscript('')
      setTranscribeError(null)
      setElapsed(0)
      setPhase('idle')
    }, [])

    const saveToNote = useCallback(async () => {
      if (!recorded) {
        return
      }
      const fileName = `${formatDateAndTimeForNote(new Date())}${extensionFor(recorded)}`
      const file = new File([recorded], fileName, { type: recorded.type })
      // Upload + insert the file node into the current (Super) editor when possible,
      // else upload + link it to the note.
      if (note.noteType === 'super') {
        filesController.uploadAndInsertFileToCurrentNote(file)
      } else {
        const uploaded = await filesController.uploadNewFile(file, { note })
        if (!uploaded) {
          addToast({ type: ToastType.Error, message: 'Could not save the recording.' })
          return
        }
      }
      addToast({ type: ToastType.Success, message: 'Recording attached to note.' })
      close()
    }, [recorded, note, filesController, close])

    const transcribe = useCallback(async () => {
      if (!recorded || sttDecision.backend !== 'model') {
        return
      }
      setTranscribing(true)
      setTranscribeError(null)
      setTranscript('')
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const text = await transcribeWithModel(application, recorded, { signal: controller.signal })
        setTranscript(text)
        if (!text) {
          setTranscribeError('The endpoint returned an empty transcript.')
        }
      } catch (error) {
        setTranscribeError(error instanceof Error ? error.message : String(error))
      } finally {
        setTranscribing(false)
        abortRef.current = null
      }
    }, [recorded, application, sttDecision.backend])

    const insertTranscript = useCallback(() => {
      if (!transcript.trim()) {
        return
      }
      const ok = insertTextIntoActiveEditor(transcript.trim() + ' ')
      if (ok) {
        addToast({ type: ToastType.Success, message: 'Transcript inserted into the note.' })
        close()
      } else {
        addToast({
          type: ToastType.Error,
          message: 'Could not find a focused editor. Click in the note, then insert.',
        })
      }
    }, [transcript, close])

    const copyTranscript = useCallback(async () => {
      try {
        await navigator?.clipboard?.writeText(transcript)
        addToast({ type: ToastType.Success, message: 'Transcript copied.' })
      } catch {
        addToast({ type: ToastType.Error, message: 'Could not copy to clipboard.' })
      }
    }, [transcript])

    const canTranscribe = sttDecision.backend === 'model'

    return (
      <Modal
        title="Record audio"
        className="p-4"
        close={close}
        actions={[
          {
            label: 'Close',
            type: 'cancel',
            onClick: () => {
              recorderRef.current?.cancel()
              abortRef.current?.abort()
              close()
            },
            mobileSlot: 'left',
          },
        ]}
      >
        <div className="flex flex-col gap-4">
          {!supported && (
            <div className="rounded border border-solid border-danger bg-danger-faded p-3 text-sm">
              Audio recording is not supported in this browser.
            </div>
          )}

          {/* Data-exposure notice for transcription. */}
          {canTranscribe && (
            <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
              <div className="font-semibold text-warning">Transcription sends audio to your AI endpoint</div>
              <p className="mt-1">
                Choosing “Transcribe” uploads this recording to your configured Direct-mode AI endpoint (
                {transcriptionModel ? (
                  <>
                    model <code>{transcriptionModel}</code>
                  </>
                ) : (
                  <>using the server’s default model</>
                )}
                ) for speech-to-text. Saving the recording to the note does not send it anywhere except your own
                Standard Red Notes file storage.
              </p>
            </div>
          )}

          {/* Recorder controls */}
          <div className="flex flex-col items-center gap-3 rounded border border-border p-4">
            <div className="text-3xl font-mono tabular-nums">{formatDuration(elapsed)}</div>
            <div className="text-xs text-passive-0">
              {phase === 'recording' && 'Recording…'}
              {phase === 'paused' && 'Paused'}
              {phase === 'recorded' && 'Recorded. Save to note or transcribe.'}
              {phase === 'idle' && 'Press Record to start.'}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {phase === 'idle' && (
                <button
                  className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
                  onClick={() => void startRecording()}
                  disabled={!supported}
                >
                  <Icon type="file-music" size="small" />
                  Record
                </button>
              )}
              {phase === 'recording' && (
                <>
                  <button
                    className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm"
                    onClick={pauseRecording}
                  >
                    <Icon type="menu-close" size="small" />
                    Pause
                  </button>
                  <button
                    className="flex items-center gap-1 rounded bg-danger px-3 py-1.5 text-sm font-semibold text-danger-contrast"
                    onClick={() => void stopRecording()}
                  >
                    <Icon type="close" size="small" />
                    Stop
                  </button>
                </>
              )}
              {phase === 'paused' && (
                <>
                  <button
                    className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast"
                    onClick={resumeRecording}
                  >
                    <Icon type="forward-ios" size="small" />
                    Resume
                  </button>
                  <button
                    className="flex items-center gap-1 rounded bg-danger px-3 py-1.5 text-sm font-semibold text-danger-contrast"
                    onClick={() => void stopRecording()}
                  >
                    <Icon type="close" size="small" />
                    Stop
                  </button>
                </>
              )}
              {phase === 'recorded' && (
                <button
                  className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm"
                  onClick={discard}
                >
                  <Icon type="trash-filled" size="small" />
                  Discard
                </button>
              )}
            </div>

            {permissionError && <p className="text-sm text-danger">{permissionError}</p>}
          </div>

          {/* Playback + actions for a finished recording */}
          {recorded && recordedUrl && (
            <div className="flex flex-col gap-3">
              <audio src={recordedUrl} controls className="w-full" />
              <div className="flex flex-wrap gap-2">
                <button
                  className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast"
                  onClick={() => void saveToNote()}
                >
                  <Icon type="link" size="small" />
                  Save to note
                </button>
                <button
                  className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                  onClick={() => void transcribe()}
                  disabled={!canTranscribe || transcribing}
                  title={canTranscribe ? undefined : sttDecision.reason}
                >
                  <Icon type="dashboard" size="small" />
                  {transcribing ? 'Transcribing…' : 'Transcribe'}
                </button>
              </div>
              {!canTranscribe && (
                <p className="text-xs text-passive-0">
                  Recorded-audio transcription needs a Direct-mode AI endpoint with a{' '}
                  <code>/audio/transcriptions</code> route. For on-device speech-to-text, use live Dictation instead
                  (Chromium browsers).
                </p>
              )}
              {transcribeError && <p className="text-sm text-danger">Could not transcribe: {transcribeError}</p>}
            </div>
          )}

          {/* Transcript view */}
          {(transcript || transcribing) && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold">Transcript</label>
                <button className="text-xs text-info hover:underline" onClick={() => void copyTranscript()}>
                  Copy
                </button>
              </div>
              <textarea
                className="max-h-48 w-full resize-y rounded border border-border bg-default px-2 py-1.5 text-sm"
                rows={5}
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder={transcribing ? 'Transcribing…' : ''}
              />
              <div>
                <button
                  className="mt-1 flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
                  onClick={insertTranscript}
                  disabled={!transcript.trim()}
                >
                  <Icon type="add" size="small" />
                  Insert into note
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    )
  },
)

const AudioRecorderModal = ({ application, filesController, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[36rem]">
      <AudioRecorderContent application={application} filesController={filesController} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(AudioRecorderModal)
