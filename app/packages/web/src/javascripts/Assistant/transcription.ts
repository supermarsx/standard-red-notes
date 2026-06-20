// Speech-to-text (STT) for the audio recorder + dictation. Two backends, mirroring
// the TTS service in tts.ts:
//
//  1. Model STT — when the assistant is in DIRECT mode against an OpenAI-compatible
//     endpoint that exposes POST /v1/audio/transcriptions (e.g. OpenAI whisper-1 /
//     gpt-4o-transcribe). We reuse the configured base URL + API key and POST the
//     recorded audio Blob as multipart/form-data. This sends the AUDIO to that
//     endpoint, so the caller must surface a data-exposure notice.
//
//  2. Web Speech API — webkitSpeechRecognition / SpeechRecognition. Needs no key,
//     runs on the device (Chromium routes it through a cloud service though), and is
//     the fallback when no transcription endpoint is reachable. Chromium-only in
//     practice; Firefox/Safari do not implement it.
//
// In PROXY mode there is no transcription proxy route on the server (would need a new
// server endpoint), so model STT is reported unavailable and we fall back to Web
// Speech. See decideSttBackend() for the decision.

import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { resolveDirectAuth } from './selectionActions'
import { loadDictationSettings } from './dictationSettings'

export type SttBackend = 'model' | 'web-speech'

export interface SttAvailability {
  /** True when a model transcription endpoint can be reached (direct mode + base URL). */
  modelAvailable: boolean
  /** True when the browser exposes the Web Speech recognition API. */
  webSpeechAvailable: boolean
}

/** Common STT-capable model identifiers that hint a /audio/transcriptions endpoint exists. */
export const KNOWN_STT_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe']

/** Whether this browser exposes a usable SpeechRecognition constructor. */
export function getSpeechRecognitionCtor(): typeof SpeechRecognition | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const w = window as unknown as {
    SpeechRecognition?: typeof SpeechRecognition
    webkitSpeechRecognition?: typeof SpeechRecognition
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/**
 * Decide which STT backends are usable right now. Model STT is only attempted in
 * DIRECT mode with a base URL (the browser can POST multipart to it directly). In
 * proxy mode there is no transcription proxy route, so only Web Speech is offered.
 */
export function getSttAvailability(application: WebApplication): SttAvailability {
  const webSpeechAvailable = getSpeechRecognitionCtor() !== undefined

  const mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const modelAvailable = mode === 'direct' && Boolean(baseURL)

  return { modelAvailable, webSpeechAvailable }
}

/**
 * Choose the backend to use for a one-shot transcription, with a reason when none is
 * available. Prefers the model endpoint (most accurate, handles any recorded format),
 * else the browser's Web Speech recognition.
 */
export function decideSttBackend(availability: SttAvailability): {
  backend: SttBackend | null
  reason?: string
} {
  if (availability.modelAvailable) {
    return { backend: 'model' }
  }
  if (availability.webSpeechAvailable) {
    return { backend: 'web-speech' }
  }
  return {
    backend: null,
    reason:
      'No transcription backend available. Configure a Direct-mode AI endpoint with a transcription route, or use a Chromium-based browser for on-device speech recognition.',
  }
}

/**
 * The STT model to send to the transcription endpoint. Reuse the configured STT model
 * pref if set; otherwise the chat model only if it looks like a transcription model;
 * otherwise OpenAI's default whisper-1. Custom servers can ignore/override.
 */
export function resolveTranscriptionModel(application: WebApplication): string {
  const configured = loadDictationSettings().sttModel
  if (configured && configured.trim()) {
    return configured.trim()
  }
  const chatModel = application.getPreference(PrefKey.AssistantModel, '')
  if (KNOWN_STT_MODELS.includes(chatModel)) {
    return chatModel
  }
  return 'whisper-1'
}

export interface TranscriptionRequest {
  url: string
  headers: Record<string, string>
  formData: FormData
}

/**
 * Pure builder: assemble the multipart POST for an OpenAI-compatible
 * /audio/transcriptions call. Kept separate from `fetch` so it is unit-testable.
 * `audio` is the recorded Blob; `fileName` carries the extension so the server can
 * sniff the container (e.g. recording.webm).
 */
export function buildTranscriptionRequest(options: {
  baseURL: string
  apiKey: string
  model: string
  audio: Blob
  fileName: string
  language?: string
  extraHeaders?: Record<string, string>
}): TranscriptionRequest {
  const url = `${options.baseURL.replace(/\/$/, '')}/audio/transcriptions`

  const headers: Record<string, string> = { ...(options.extraHeaders ?? {}) }
  if (options.apiKey && options.apiKey.trim()) {
    headers['Authorization'] = `Bearer ${options.apiKey.trim()}`
  }
  // NB: do NOT set Content-Type — the browser sets the multipart boundary itself.

  const formData = new FormData()
  formData.append('file', options.audio, options.fileName)
  formData.append('model', options.model)
  formData.append('response_format', 'json')
  if (options.language && options.language.trim()) {
    formData.append('language', options.language.trim())
  }

  return { url, headers, formData }
}

/**
 * POST the recorded audio to the configured Direct-mode transcription endpoint and
 * return the transcript text. Throws on a non-OK response so the caller can surface
 * the error or fall back. Direct mode only — proxy mode has no transcription route.
 */
export async function transcribeWithModel(
  application: WebApplication,
  audio: Blob,
  options: { fileName?: string; language?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  if (!baseURL) {
    throw new Error('No base URL configured for the transcription endpoint.')
  }
  const auth = resolveDirectAuth(application)
  const fileName = options.fileName ?? inferFileName(audio)
  const language = options.language ?? loadDictationSettings().language

  const { url, headers, formData } = buildTranscriptionRequest({
    baseURL,
    apiKey: auth.apiKey,
    model: resolveTranscriptionModel(application),
    audio,
    fileName,
    language,
    extraHeaders: auth.extraHeaders,
  })

  const response = await fetch(url, { method: 'POST', headers, body: formData, signal: options.signal })

  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      /* ignore */
    }
    throw new Error(
      `transcription endpoint: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
    )
  }

  // OpenAI returns { text }. Some servers may return plain text.
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
  return (await response.text()).trim()
}

/** Best-effort file name (with extension) for a recorded blob, from its MIME type. */
export function inferFileName(audio: Blob, base = 'recording'): string {
  const type = audio.type || ''
  if (type.includes('webm')) {
    return `${base}.webm`
  }
  if (type.includes('ogg')) {
    return `${base}.ogg`
  }
  if (type.includes('mp4') || type.includes('m4a')) {
    return `${base}.mp4`
  }
  if (type.includes('mpeg') || type.includes('mp3')) {
    return `${base}.mp3`
  }
  if (type.includes('wav')) {
    return `${base}.wav`
  }
  return `${base}.webm`
}

/**
 * One-shot transcription of a recorded Blob. Only the model backend can transcribe a
 * pre-recorded Blob — SpeechRecognition (Web Speech) only listens to the live mic, it
 * cannot accept a Blob. So when the model endpoint is unavailable this throws with a
 * reason, and the caller should steer the user to live dictation instead. Returns the
 * transcript text plus the backend used.
 */
export async function transcribeBlob(
  application: WebApplication,
  audio: Blob,
  options: { fileName?: string; language?: string; signal?: AbortSignal } = {},
): Promise<{ text: string; backend: SttBackend }> {
  const availability = getSttAvailability(application)
  const decision = decideSttBackend(availability)
  if (decision.backend === 'model') {
    const text = await transcribeWithModel(application, audio, options)
    return { text, backend: 'model' }
  }
  // Web Speech cannot transcribe a recorded blob; signal the caller to use live mode.
  throw new Error(
    decision.reason ??
      'Recorded-audio transcription needs a Direct-mode endpoint with a /audio/transcriptions route. Use live dictation for on-device speech recognition.',
  )
}
