// Live "type by speaking" dictation backed by the browser SpeechRecognition API
// (webkitSpeechRecognition on Chromium). Streams interim + final results; on each
// FINAL segment it calls onFinalText so the caller can insert it into the editor at
// the caret. Interim results are surfaced via onInterim for a live preview only.
//
// Browser support is effectively Chromium-only — Firefox and Safari do not implement
// SpeechRecognition. getSpeechRecognitionCtor() returns undefined elsewhere, and the
// UI hides/disables dictation accordingly. The mic is only opened on a user gesture
// (the caller starts this from a click), and permission denial surfaces via onError.

import { getSpeechRecognitionCtor } from './transcription'

export type DictationState = 'idle' | 'listening' | 'error'

export interface DictationOptions {
  /** BCP-47 language hint, e.g. 'en-US'. Empty/undefined lets the browser decide. */
  language?: string
  /** Called with each finalized segment of recognized text (ready to insert). */
  onFinalText: (text: string) => void
  /** Called with the current interim (not-yet-final) text for a live preview. */
  onInterim?: (text: string) => void
  onState?: (state: DictationState) => void
  onError?: (message: string) => void
}

export interface DictationHandle {
  stop: () => void
  /** True while the recognizer is actively listening. */
  isListening: () => boolean
}

/** A no-op handle for the unsupported path so callers don't branch on null. */
const NOOP_HANDLE: DictationHandle = { stop: () => undefined, isListening: () => false }

/**
 * Start live dictation. Returns a handle to stop it. Must be called from a user
 * gesture so the browser will grant mic permission. Continuous recognition with
 * interim results; auto-restarts on benign end events so a single session keeps
 * listening until the caller stops it.
 */
export function startDictation(options: DictationOptions): DictationHandle {
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) {
    options.onError?.('Speech recognition is not supported in this browser (try a Chromium-based browser).')
    options.onState?.('error')
    return NOOP_HANDLE
  }

  const recognition = new Ctor()
  recognition.continuous = true
  recognition.interimResults = true
  if (options.language && options.language.trim()) {
    recognition.lang = options.language.trim()
  }

  let stopped = false
  let listening = false

  recognition.onstart = () => {
    listening = true
    options.onState?.('listening')
  }

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0]?.transcript ?? ''
      if (result.isFinal) {
        const finalText = transcript.trim()
        if (finalText) {
          // Add a trailing space so consecutive segments don't run together.
          options.onFinalText(finalText.endsWith(' ') ? finalText : `${finalText} `)
        }
      } else {
        interim += transcript
      }
    }
    options.onInterim?.(interim)
  }

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    // 'no-speech'/'aborted' happen on normal pauses/stops; don't treat as fatal.
    if (event.error === 'no-speech' || event.error === 'aborted') {
      return
    }
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopped = true
      options.onError?.('Microphone permission was denied. Allow mic access to dictate.')
      options.onState?.('error')
      return
    }
    options.onError?.(`Speech recognition error: ${event.error}`)
    options.onState?.('error')
  }

  recognition.onend = () => {
    listening = false
    // The engine ends sessions periodically; restart unless the user stopped it.
    if (!stopped) {
      try {
        recognition.start()
      } catch {
        // start() can throw if already starting; ignore and let the next end retry.
      }
      return
    }
    options.onState?.('idle')
  }

  try {
    recognition.start()
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error))
    options.onState?.('error')
    return NOOP_HANDLE
  }

  return {
    stop: () => {
      stopped = true
      try {
        recognition.stop()
      } catch {
        /* already stopped */
      }
      options.onState?.('idle')
    },
    isListening: () => listening,
  }
}
