// Audio-only recorder built on getUserMedia({ audio: true }) + MediaRecorder. Picks
// the best container the browser supports (webm/ogg/mp4), supports start/pause/resume/
// stop, and resolves a single Blob on stop. Audio recordings are small, so the normal
// (synced) file-upload path applies when saved to a note.
//
// The mic is only opened by initialize(), which the UI calls from a user gesture, and
// getUserMedia rejection (permission denied / no device) propagates so the caller can
// show a friendly message.

import { Deferred } from '@standardnotes/snjs'

/** Candidate MIME types in order of preference; first supported one wins. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
]

export class AudioRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private mimeType = ''
  private dataReadyPromise = Deferred<Blob>()
  private startedAt = 0
  /** Accumulated milliseconds across pause/resume cycles. */
  private accumulatedMs = 0

  public static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window !== 'undefined' &&
      typeof window.MediaRecorder !== 'undefined'
    )
  }

  /** Resolve the best supported MIME type, or '' to let the browser default. */
  public static pickMimeType(): string {
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      return ''
    }
    for (const type of PREFERRED_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type
      }
    }
    return ''
  }

  /** Open the mic. Throws on permission denial / no device. */
  public async initialize(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.mimeType = AudioRecorder.pickMimeType()
    this.recorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
      : new MediaRecorder(this.stream)

    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data)
      }
    }
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || this.mimeType || 'audio/webm'
      const blob = new Blob(this.chunks, { type })
      this.dataReadyPromise.resolve(blob)
    }
  }

  public start(): void {
    if (!this.recorder) {
      throw new Error('AudioRecorder not initialized')
    }
    this.chunks = []
    this.accumulatedMs = 0
    this.startedAt = Date.now()
    // Timeslice so dataavailable fires periodically (more reliable across browsers).
    this.recorder.start(1000)
  }

  public pause(): void {
    if (this.recorder && this.recorder.state === 'recording') {
      this.accumulatedMs += Date.now() - this.startedAt
      this.recorder.pause()
    }
  }

  public resume(): void {
    if (this.recorder && this.recorder.state === 'paused') {
      this.startedAt = Date.now()
      this.recorder.resume()
    }
  }

  /** Milliseconds of audio captured so far (across pause/resume). */
  public elapsedMs(): number {
    if (this.recorder && this.recorder.state === 'recording') {
      return this.accumulatedMs + (Date.now() - this.startedAt)
    }
    return this.accumulatedMs
  }

  public get state(): RecordingState {
    return this.recorder?.state ?? 'inactive'
  }

  public get resolvedMimeType(): string {
    return this.recorder?.mimeType || this.mimeType || 'audio/webm'
  }

  /** Stop recording, release the mic, and resolve the recorded Blob. */
  public async stop(): Promise<Blob> {
    if (this.recorder && this.recorder.state === 'recording') {
      this.accumulatedMs += Date.now() - this.startedAt
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop()
    } else {
      // Never started / already stopped: resolve an empty blob so callers don't hang.
      this.dataReadyPromise.resolve(new Blob(this.chunks, { type: this.resolvedMimeType }))
    }
    this.releaseStream()
    return this.dataReadyPromise.promise
  }

  /** Abort without producing a usable blob (e.g. on cancel) and free the mic. */
  public cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop()
      }
    } catch {
      /* ignore */
    }
    this.releaseStream()
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}
