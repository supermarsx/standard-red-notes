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
  /**
   * Free-text language / dialect hint (e.g. "British English", "es-ES"). Sent to
   * the model TTS request and applied as a BCP-47-ish `lang` on Web Speech when it
   * looks like a language tag.
   */
  language?: string
  /**
   * Optional free-text delivery clarification (e.g. "speak slowly and clearly").
   * For model TTS it is passed as an `instructions` field; for Web Speech we cannot
   * honor arbitrary instructions, so it only shapes the model request.
   */
  clarification?: string
  /** Force a backend; default is model when available, else web-speech. */
  backend?: TtsBackend
  onState?: (state: TtsState) => void
  onError?: (message: string) => void
  /**
   * Fired once the model-TTS audio Blob is available (model backend only). Lets the
   * caller persist the produced narration audio. Not called for Web Speech, which
   * produces no downloadable audio.
   */
  onAudioReady?: (blob: Blob) => void
}

export interface TtsHandle {
  pause: () => void
  resume: () => void
  stop: () => void
  backend: TtsBackend
  /**
   * Seek to an absolute time in seconds. No-op for backends that cannot seek
   * (Web Speech). Model backend seeks the underlying <audio> element.
   */
  seek?: (seconds: number) => void
  /**
   * Subscribe to playback time updates: (currentTime, duration) in seconds.
   * Returns an unsubscribe fn. Web Speech reports (0, 0) — it has no timeline.
   */
  onTime?: (cb: (current: number, duration: number) => void) => () => void
}

/**
 * Build the spoken-delivery `instructions` string sent to model TTS from a
 * language/dialect hint and an optional free-text clarification. Pure + exported
 * so the request shape can be unit-tested. Returns '' when there is nothing to say.
 */
export function buildSpeechInstructions(language?: string, clarification?: string): string {
  const parts: string[] = []
  const lang = (language ?? '').trim()
  const clar = (clarification ?? '').trim()
  if (lang) {
    parts.push(`Speak in ${lang}.`)
  }
  if (clar) {
    parts.push(clar)
  }
  return parts.join(' ')
}

/**
 * Fetch model-generated speech audio for `text` and return the audio Blob. Throws
 * on a non-OK response so the caller can fall back. A language/dialect hint and a
 * free-text clarification are passed as `language` and `instructions` (OpenAI's
 * gpt-4o-mini-tts honors `instructions`; servers that ignore the extra fields still
 * produce audio).
 */
async function fetchModelSpeech(
  application: WebApplication,
  text: string,
  modelVoice: string,
  options: { language?: string; clarification?: string } = {},
  signal?: AbortSignal,
): Promise<Blob> {
  const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
  const apiKey = application.getPreference(PrefKey.AssistantApiKey, '')
  const url = `${baseURL.replace(/\/$/, '')}/audio/speech`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  const instructions = buildSpeechInstructions(options.language, options.clarification)
  const body: Record<string, unknown> = {
    model: resolveSpeechModel(application),
    voice: modelVoice || 'alloy',
    input: text,
    response_format: 'mp3',
  }
  if (instructions) {
    body.instructions = instructions
  }
  const language = (options.language ?? '').trim()
  if (language) {
    body.language = language
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
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

  return response.blob()
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
  const timeListeners = new Set<(current: number, duration: number) => void>()

  const cleanup = () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const emitTime = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0
    for (const listener of timeListeners) {
      listener(audio.currentTime || 0, duration)
    }
  }
  audio.ontimeupdate = emitTime
  audio.ondurationchange = emitTime
  audio.onloadedmetadata = emitTime

  options.onState?.('loading')

  fetchModelSpeech(
    application,
    options.text,
    options.modelVoice ?? '',
    { language: options.language, clarification: options.clarification },
    abort.signal,
  )
    .then((blob) => {
      if (stopped) {
        return
      }
      // Surface the produced audio so callers can persist/replay it.
      options.onAudioReady?.(blob)
      const url = URL.createObjectURL(blob)
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
        boundHandle.seek = fallback.seek
        boundHandle.onTime = fallback.onTime
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
      timeListeners.clear()
      options.onState?.('idle')
    },
    seek: (seconds: number) => {
      if (Number.isFinite(seconds)) {
        try {
          audio.currentTime = Math.max(0, seconds)
        } catch {
          /* seeking before metadata loads can throw; ignore */
        }
      }
    },
    onTime: (cb) => {
      timeListeners.add(cb)
      return () => timeListeners.delete(cb)
    },
  }
  return boundHandle
}

/**
 * Split narration into small, sentence-aligned chunks. Chromium-based browsers
 * silently stop a SpeechSynthesisUtterance after ~15 seconds / a few hundred
 * characters, so speaking a whole note as one utterance cuts off partway. We
 * speak a queue of short chunks instead. Exported for testing.
 */
export function splitIntoSpeechChunks(text: string, maxLength = 160): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) {
    return []
  }
  const sentences = normalized.match(/[^.!?]+[.!?]*\s*/g) ?? [normalized]
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed.length > 0) {
      chunks.push(trimmed)
    }
    current = ''
  }

  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      flush()
      let rest = sentence
      while (rest.length > maxLength) {
        let cut = rest.lastIndexOf(' ', maxLength)
        if (cut <= 0) {
          cut = maxLength
        }
        const piece = rest.slice(0, cut).trim()
        if (piece.length > 0) {
          chunks.push(piece)
        }
        rest = rest.slice(cut)
      }
      current = rest
    } else if ((current + sentence).length > maxLength) {
      flush()
      current = sentence
    } else {
      current += sentence
    }
  }
  flush()
  return chunks
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

  const chunks = splitIntoSpeechChunks(options.text)
  if (chunks.length === 0) {
    options.onState?.('ended')
    return { backend: 'web-speech', pause: () => undefined, resume: () => undefined, stop: () => undefined }
  }

  const voice = options.voiceURI
    ? synth.getVoices().find((candidate) => candidate.voiceURI === options.voiceURI)
    : undefined

  let index = 0
  let stopped = false
  let started = false
  let paused = false
  let keepAlive: ReturnType<typeof setInterval> | undefined

  const stopKeepAlive = () => {
    if (keepAlive !== undefined) {
      clearInterval(keepAlive)
      keepAlive = undefined
    }
  }
  // Chromium auto-pauses long-running synthesis; a periodic resume (when not
  // intentionally paused) keeps the queue moving across chunks.
  keepAlive = setInterval(() => {
    if (!stopped && !paused && synth.speaking) {
      synth.resume()
    }
  }, 10000)

  const speakNext = () => {
    if (stopped || index >= chunks.length) {
      stopKeepAlive()
      if (!stopped) {
        options.onState?.('ended')
      }
      return
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index])
    utterance.rate = options.rate ?? 1
    if (voice) {
      utterance.voice = voice
    }
    // Apply the language hint only when it looks like a BCP-47 tag (e.g. en-GB);
    // free-text names like "British English" are not valid SpeechSynthesis langs.
    const langTag = (options.language ?? '').trim()
    if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(langTag)) {
      utterance.lang = langTag
    }
    utterance.onstart = () => {
      if (!started) {
        started = true
        options.onState?.('playing')
      }
    }
    utterance.onend = () => {
      if (!stopped) {
        index++
        speakNext()
      }
    }
    utterance.onerror = (event) => {
      // 'interrupted'/'canceled' happen on a normal stop; don't surface them.
      if (event.error === 'interrupted' || event.error === 'canceled') {
        return
      }
      stopKeepAlive()
      options.onError?.(`Speech synthesis error: ${event.error}`)
      options.onState?.('error')
    }
    synth.speak(utterance)
  }

  speakNext()

  return {
    backend: 'web-speech',
    pause: () => {
      if (synth.speaking && !synth.paused) {
        paused = true
        synth.pause()
        options.onState?.('paused')
      }
    },
    resume: () => {
      if (synth.paused) {
        paused = false
        synth.resume()
        options.onState?.('playing')
      }
    },
    stop: () => {
      stopped = true
      stopKeepAlive()
      synth.cancel()
      options.onState?.('idle')
    },
    // Web Speech has no seekable timeline; expose inert seek/onTime so the floating
    // player can treat both backends uniformly.
    seek: () => undefined,
    onTime: (cb) => {
      cb(0, 0)
      return () => undefined
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
