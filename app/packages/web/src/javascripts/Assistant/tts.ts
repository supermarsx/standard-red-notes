// Text-to-speech playback for narration. Two backends:
//
//  1. Model TTS — when the assistant is in DIRECT mode against an OpenAI-compatible
//     endpoint that exposes POST /v1/audio/speech (e.g. OpenAI tts-1). We reuse the
//     configured base URL + API key, request MP3 audio, and play it via an <audio>
//     element. This sends the narration TEXT to that endpoint.
//
//  2. Web Speech API — window.speechSynthesis + SpeechSynthesisUtterance. Needs no
//     key, runs on local OS voices, and is the default/fallback so narration works
//     even with no TTS model configured. Voice availability varies by OS/browser.
//
// We expose a uniform play/pause/resume/stop surface plus simple state callbacks so
// the player UI does not need to know which backend is active.

import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

export type TtsBackend = 'model' | 'web-speech'

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface TtsAvailability {
  /** True when a model speech endpoint can be reached (direct mode + base URL). */
  modelAvailable: boolean
  /** True when the browser exposes the Web Speech API. */
  webSpeechAvailable: boolean
}

/** Common TTS-capable model identifiers that hint a /audio/speech endpoint exists. */
const KNOWN_TTS_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts']

/**
 * Decide which TTS backends are usable right now. Model TTS is only attempted in
 * DIRECT mode (we have a base URL the browser can POST to). In proxy mode there is no
 * speech proxy route, so we fall back to Web Speech.
 */
export function getTtsAvailability(application: WebApplication): TtsAvailability {
  const webSpeechAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window

  const mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const modelAvailable = mode === 'direct' && Boolean(baseURL)

  return { modelAvailable, webSpeechAvailable }
}

/** A speech model the endpoint should understand; reuse the chat model only if it looks like a TTS model. */
export function resolveSpeechModel(application: WebApplication): string {
  const chatModel = application.getPreference(PrefKey.AssistantModel, '')
  if (KNOWN_TTS_MODELS.includes(chatModel)) {
    return chatModel
  }
  // OpenAI's default speech model. Custom servers can ignore/override as needed.
  return 'tts-1'
}

export interface TtsPlayOptions {
  text: string
  /** Web Speech voiceURI to select (best-effort). */
  voiceURI?: string
  /** Speaking rate multiplier (Web Speech). 1 = normal. */
  rate?: number
  /** Model-TTS voice name (e.g. 'alloy'). */
  modelVoice?: string
  /** Force a backend; default is model when available, else web-speech. */
  backend?: TtsBackend
  onState?: (state: TtsState) => void
  onError?: (message: string) => void
}

export interface TtsHandle {
  pause: () => void
  resume: () => void
  stop: () => void
  backend: TtsBackend
}

/**
 * Fetch model-generated speech audio for `text` and return an object URL for an
 * <audio> element. Throws on a non-OK response so the caller can fall back.
 */
async function fetchModelSpeech(
  application: WebApplication,
  text: string,
  modelVoice: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const apiKey = application.getPreference(PrefKey.AssistantApiKey, '')
  const url = `${baseURL.replace(/\/$/, '')}/audio/speech`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: resolveSpeechModel(application),
      voice: modelVoice || 'alloy',
      input: text,
      response_format: 'mp3',
    }),
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      /* ignore */
    }
    throw new Error(`speech endpoint: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }

  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

/**
 * Start playback. Returns a handle with pause/resume/stop. Picks the model backend
 * when available unless `backend` forces otherwise; on any model failure it falls
 * back to Web Speech automatically.
 */
export function playNarration(application: WebApplication, options: TtsPlayOptions): TtsHandle {
  const availability = getTtsAvailability(application)
  const wantModel = options.backend ? options.backend === 'model' : availability.modelAvailable
  const useModel = wantModel && availability.modelAvailable

  if (useModel) {
    return playWithModel(application, options, availability)
  }
  return playWithWebSpeech(options)
}

function playWithModel(
  application: WebApplication,
  options: TtsPlayOptions,
  availability: TtsAvailability,
): TtsHandle {
  const audio = new Audio()
  const abort = new AbortController()
  let objectUrl: string | null = null
  let stopped = false

  const cleanup = () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  options.onState?.('loading')

  fetchModelSpeech(application, options.text, options.modelVoice ?? '', abort.signal)
    .then((url) => {
      if (stopped) {
        URL.revokeObjectURL(url)
        return
      }
      objectUrl = url
      audio.src = url
      audio.onplay = () => options.onState?.('playing')
      audio.onpause = () => {
        if (!audio.ended && !stopped) {
          options.onState?.('paused')
        }
      }
      audio.onended = () => {
        cleanup()
        options.onState?.('ended')
      }
      audio.onerror = () => {
        cleanup()
        options.onError?.('Audio playback failed.')
        options.onState?.('error')
      }
      void audio.play().catch((error) => {
        options.onError?.(error instanceof Error ? error.message : String(error))
        options.onState?.('error')
      })
    })
    .catch((error) => {
      if (stopped) {
        return
      }
      // Model TTS failed — fall back to Web Speech so the user still hears something.
      if (availability.webSpeechAvailable) {
        options.onError?.(
          `Model TTS unavailable (${error instanceof Error ? error.message : String(error)}); using device voice.`,
        )
        const fallback = playWithWebSpeech(options)
        // Re-bind the handle's controls to the fallback.
        boundHandle.pause = fallback.pause
        boundHandle.resume = fallback.resume
        boundHandle.stop = fallback.stop
        boundHandle.backend = 'web-speech'
      } else {
        options.onError?.(error instanceof Error ? error.message : String(error))
        options.onState?.('error')
      }
    })

  const boundHandle: TtsHandle = {
    backend: 'model',
    pause: () => {
      audio.pause()
    },
    resume: () => {
      void audio.play().catch(() => undefined)
    },
    stop: () => {
      stopped = true
      abort.abort()
      audio.pause()
      audio.src = ''
      cleanup()
      options.onState?.('idle')
    },
  }
  return boundHandle
}

function playWithWebSpeech(options: TtsPlayOptions): TtsHandle {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    options.onError?.('Text-to-speech is not supported in this browser.')
    options.onState?.('error')
    return { backend: 'web-speech', pause: () => undefined, resume: () => undefined, stop: () => undefined }
  }

  const synth = window.speechSynthesis
  // Cancel anything already speaking so we never overlap utterances.
  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(options.text)
  utterance.rate = options.rate ?? 1

  if (options.voiceURI) {
    const voice = synth.getVoices().find((candidate) => candidate.voiceURI === options.voiceURI)
    if (voice) {
      utterance.voice = voice
    }
  }

  utterance.onstart = () => options.onState?.('playing')
  utterance.onend = () => options.onState?.('ended')
  utterance.onerror = (event) => {
    // 'interrupted'/'canceled' happen on a normal stop; don't surface them as errors.
    if (event.error === 'interrupted' || event.error === 'canceled') {
      return
    }
    options.onError?.(`Speech synthesis error: ${event.error}`)
    options.onState?.('error')
  }

  synth.speak(utterance)

  return {
    backend: 'web-speech',
    pause: () => {
      if (synth.speaking && !synth.paused) {
        synth.pause()
        options.onState?.('paused')
      }
    },
    resume: () => {
      if (synth.paused) {
        synth.resume()
        options.onState?.('playing')
      }
    },
    stop: () => {
      synth.cancel()
      options.onState?.('idle')
    },
  }
}

/**
 * List Web Speech voices. Voices may load asynchronously, so callers should also
 * subscribe to `speechSynthesis.onvoiceschanged`. Returns [] when unsupported.
 */
export function listWebSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return []
  }
  return window.speechSynthesis.getVoices()
}
