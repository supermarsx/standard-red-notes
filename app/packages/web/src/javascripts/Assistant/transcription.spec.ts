import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  buildTranscriptionRequest,
  decideSttBackend,
  getSttAvailability,
  inferFileName,
  resolveTranscriptionModel,
  SttAvailability,
} from './transcription'

type Prefs = Partial<Record<string, unknown>>

function fakeApplication(prefs: Prefs = {}): WebApplication {
  return {
    getPreference: (key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : defaultValue,
    hasAccount: () => false,
  } as unknown as WebApplication
}

beforeEach(() => {
  localStorage.clear()
})

describe('buildTranscriptionRequest', () => {
  it('assembles a multipart POST to /audio/transcriptions with file + model fields', () => {
    const audio = new Blob(['abc'], { type: 'audio/webm' })
    const req = buildTranscriptionRequest({
      baseURL: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'whisper-1',
      audio,
      fileName: 'recording.webm',
    })

    // Trailing slash is normalized, route appended.
    expect(req.url).toBe('https://api.example.com/v1/audio/transcriptions')
    expect(req.headers['Authorization']).toBe('Bearer sk-test')
    // Crucially we must NOT set Content-Type (browser adds the multipart boundary).
    expect(req.headers['Content-Type']).toBeUndefined()

    expect(req.formData.get('model')).toBe('whisper-1')
    expect(req.formData.get('response_format')).toBe('json')
    const file = req.formData.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect(req.formData.get('language')).toBeNull()
  })

  it('omits the Authorization header when no key is provided', () => {
    const req = buildTranscriptionRequest({
      baseURL: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'whisper-1',
      audio: new Blob([''], { type: 'audio/webm' }),
      fileName: 'r.webm',
    })
    expect(req.headers['Authorization']).toBeUndefined()
  })

  it('includes a language field when given and merges extra headers', () => {
    const req = buildTranscriptionRequest({
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'k',
      model: 'whisper-1',
      audio: new Blob([''], { type: 'audio/webm' }),
      fileName: 'r.webm',
      language: 'en-US',
      extraHeaders: { 'X-Account': 'acct_1' },
    })
    expect(req.formData.get('language')).toBe('en-US')
    expect(req.headers['X-Account']).toBe('acct_1')
  })
})

describe('decideSttBackend', () => {
  const avail = (over: Partial<SttAvailability> = {}): SttAvailability => ({
    modelAvailable: false,
    webSpeechAvailable: false,
    ...over,
  })

  it('prefers the model backend when available', () => {
    expect(decideSttBackend(avail({ modelAvailable: true, webSpeechAvailable: true })).backend).toBe('model')
  })

  it('falls back to web-speech when the model endpoint is unavailable', () => {
    expect(decideSttBackend(avail({ modelAvailable: false, webSpeechAvailable: true })).backend).toBe('web-speech')
  })

  it('returns no backend (with a reason) when neither is available', () => {
    const decision = decideSttBackend(avail())
    expect(decision.backend).toBeNull()
    expect(decision.reason).toBeTruthy()
  })
})

describe('getSttAvailability', () => {
  it('reports model available only in direct mode with a base URL', () => {
    const direct = getSttAvailability(
      fakeApplication({ [PrefKey.AssistantConnectionMode]: 'direct', [PrefKey.AssistantBaseUrl]: 'http://x/v1' }),
    )
    expect(direct.modelAvailable).toBe(true)
  })

  it('reports model unavailable in proxy mode (no transcription route)', () => {
    const proxy = getSttAvailability(
      fakeApplication({ [PrefKey.AssistantConnectionMode]: 'proxy', [PrefKey.AssistantBaseUrl]: 'http://x/v1' }),
    )
    expect(proxy.modelAvailable).toBe(false)
  })

  it('reports model unavailable in direct mode without a base URL', () => {
    const direct = getSttAvailability(fakeApplication({ [PrefKey.AssistantConnectionMode]: 'direct' }))
    expect(direct.modelAvailable).toBe(false)
  })
})

describe('resolveTranscriptionModel', () => {
  it('defaults to whisper-1 when nothing relevant is configured', () => {
    expect(resolveTranscriptionModel(fakeApplication())).toBe('whisper-1')
  })

  it('uses a chat model that looks like an STT model', () => {
    expect(resolveTranscriptionModel(fakeApplication({ [PrefKey.AssistantModel]: 'gpt-4o-transcribe' }))).toBe(
      'gpt-4o-transcribe',
    )
  })

  it('does not use a chat model that is not an STT model', () => {
    expect(resolveTranscriptionModel(fakeApplication({ [PrefKey.AssistantModel]: 'gpt-4o' }))).toBe('whisper-1')
  })

  it('prefers the locally-configured STT model override', () => {
    localStorage.setItem('standardnotes.dictation.settings.v1', JSON.stringify({ sttModel: 'my-whisper' }))
    expect(resolveTranscriptionModel(fakeApplication({ [PrefKey.AssistantModel]: 'gpt-4o-transcribe' }))).toBe(
      'my-whisper',
    )
  })
})

describe('inferFileName', () => {
  it('maps common audio MIME types to extensions', () => {
    expect(inferFileName(new Blob([''], { type: 'audio/webm;codecs=opus' }))).toBe('recording.webm')
    expect(inferFileName(new Blob([''], { type: 'audio/ogg' }))).toBe('recording.ogg')
    expect(inferFileName(new Blob([''], { type: 'audio/mp4' }))).toBe('recording.mp4')
    expect(inferFileName(new Blob([''], { type: 'audio/mpeg' }))).toBe('recording.mp3')
    expect(inferFileName(new Blob([''], { type: 'audio/wav' }))).toBe('recording.wav')
  })

  it('falls back to webm for an unknown/empty type', () => {
    expect(inferFileName(new Blob(['']))).toBe('recording.webm')
  })
})
