import { Deferred } from '@standardnotes/snjs'

export class VideoRecorder {
  public video!: HTMLVideoElement

  private canvas!: HTMLCanvasElement
  private width!: number
  private height!: number
  private stream!: MediaStream
  private recorder!: MediaRecorder

  private dataReadyPromise = Deferred<File>()

  constructor(private fileName: string) {}

  public static async isSupported(): Promise<boolean> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const hasCamera = devices.some((device) => device.kind === 'videoinput')
    return hasCamera
  }

  public async initialize() {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    this.recorder = new MediaRecorder(this.stream)

    this.video = document.createElement('video')
    this.video.playsInline = true
    this.video.style.position = 'absolute'
    this.video.style.display = 'none'
    this.video.volume = 0

    this.canvas = document.createElement('canvas')

    document.body.append(this.video)
    this.video.srcObject = this.stream

    await this.video.play()
    await this.awaitVideoReady(this.video)

    const videoTrack = this.stream.getVideoTracks()[0]
    const settings = videoTrack.getSettings()
    this.width = settings.width ?? 1280
    this.height = settings.height ?? 720

    this.canvas.width = this.width
    this.canvas.height = this.height
  }

  public async startRecording(): Promise<void> {
    this.recorder.start()

    this.recorder.ondataavailable = this.onData
  }

  private onData = async (event: BlobEvent) => {
    /**
     * The recorded Blob goes straight into the File. It used to be round-tripped
     * through `URL.createObjectURL` + `fetch`, which copied the whole recording
     * for no reason, leaked the object URL, and made the recorder depend on CSP
     * `connect-src` admitting `blob:`.
     */
    const file = new File([event.data], this.fileName, { type: 'video/mp4' })

    this.dataReadyPromise.resolve(file)
  }

  public async stop(): Promise<File> {
    this.video.pause()
    if (this.recorder.state !== 'inactive') {
      this.recorder.stop()
    }

    this.video.parentElement?.removeChild(this.video)
    this.canvas.parentElement?.removeChild(this.canvas)

    this.video.remove()
    this.canvas.remove()

    this.stream.getTracks().forEach((track) => {
      track.stop()
    })

    return this.dataReadyPromise.promise
  }

  private async awaitVideoReady(video: HTMLVideoElement) {
    return new Promise((resolve) => {
      video.addEventListener('canplaythrough', () => {
        resolve(null)
      })
    })
  }
}
