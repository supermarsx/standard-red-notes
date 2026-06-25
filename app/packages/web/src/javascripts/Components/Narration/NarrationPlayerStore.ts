// App-wide store that drives the floating narration player. A single mobx
// observable singleton: whatever component starts a narration calls `start(...)`
// with a TtsHandle + display metadata, and the FloatingNarrationPlayer (mounted
// once at the app root) renders/controls it. Keeping the player out of the modal
// means playback (and its controls) survive after the Narrate dialog is closed.

import { action, makeObservable, observable } from 'mobx'
import { TtsHandle, TtsState } from '@/Assistant/tts'

export interface NarrationPlaybackMeta {
  /** Note display title (for the player heading). */
  noteTitle: string
  /** Backend in use ('model' | 'web-speech'). */
  backend: TtsHandle['backend']
  /** Free-text language/dialect label, or '' when none was specified. */
  language: string
}

export class NarrationPlayerStore {
  /** True while a narration is active and the floating player should be shown. */
  active = false
  state: TtsState = 'idle'
  meta: NarrationPlaybackMeta = { noteTitle: '', backend: 'web-speech', language: '' }
  currentTime = 0
  duration = 0
  errorMessage: string | null = null

  private handle: TtsHandle | null = null
  private unsubscribeTime: (() => void) | null = null

  constructor() {
    makeObservable(this, {
      active: observable,
      state: observable,
      meta: observable.ref,
      currentTime: observable,
      duration: observable,
      errorMessage: observable,
      start: action,
      setState: action,
      setTime: action,
      setError: action,
      dismiss: action,
    })
  }

  /**
   * Take over the floating player with a freshly-started narration. The caller owns
   * generating the audio and starting playback (via tts.playNarration); it passes
   * the resulting handle here so the player UI can control it. Any previous handle
   * is stopped first.
   */
  start(handle: TtsHandle, meta: NarrationPlaybackMeta): void {
    this.teardown()
    this.handle = handle
    this.meta = meta
    this.active = true
    this.state = 'loading'
    this.currentTime = 0
    this.duration = 0
    this.errorMessage = null
    this.unsubscribeTime =
      handle.onTime?.((current, duration) => this.setTime(current, duration)) ?? null
  }

  setState(state: TtsState): void {
    this.state = state
    if (state === 'idle') {
      this.active = false
    }
  }

  setTime(current: number, duration: number): void {
    this.currentTime = current
    this.duration = duration
  }

  setError(message: string | null): void {
    this.errorMessage = message
  }

  pause(): void {
    this.handle?.pause()
  }

  resume(): void {
    this.handle?.resume()
  }

  seek(seconds: number): void {
    this.handle?.seek?.(seconds)
  }

  get canSeek(): boolean {
    return this.handle?.backend === 'model' && this.duration > 0
  }

  /** Stop playback and hide the player. */
  dismiss(): void {
    this.teardown()
    this.active = false
    this.state = 'idle'
    this.currentTime = 0
    this.duration = 0
    this.errorMessage = null
  }

  private teardown(): void {
    this.unsubscribeTime?.()
    this.unsubscribeTime = null
    this.handle?.stop()
    this.handle = null
  }
}

/** The single app-wide instance used by the modal and the floating player. */
export const narrationPlayerStore = new NarrationPlayerStore()
