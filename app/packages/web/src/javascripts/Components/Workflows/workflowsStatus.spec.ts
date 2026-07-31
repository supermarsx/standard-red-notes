import {
  WorkflowsStatusState,
  WorkflowsStatusService,
  openExternalWorkflowsUrl,
  parseWorkflowsStatus,
  resolveWorkflowsPublicUrl,
  shouldShowWorkflowsSection,
} from './workflowsStatus'
import { WebApplication } from '@/Application/WebApplication'

const loaded = (enabled: boolean, available = false, publicUrl: string | null = null): WorkflowsStatusState => ({
  kind: 'loaded',
  status: {
    enabled,
    available,
    publicUrl,
    configurationError: enabled && !available,
    authentication: 'n8n',
  },
})

describe('shouldShowWorkflowsSection', () => {
  it('is visible only when signed in and account discovery is enabled', () => {
    expect(shouldShowWorkflowsSection(true, loaded(true))).toBe(true)
    expect(shouldShowWorkflowsSection(true, loaded(true, true, 'https://n8n.example.com/'))).toBe(true)
    expect(shouldShowWorkflowsSection(false, loaded(true))).toBe(false)
    expect(shouldShowWorkflowsSection(true, loaded(false))).toBe(false)
  })

  it('is hidden for non-loaded states', () => {
    expect(shouldShowWorkflowsSection(true, { kind: 'unknown' })).toBe(false)
    expect(shouldShowWorkflowsSection(true, { kind: 'loading' })).toBe(false)
    expect(shouldShowWorkflowsSection(true, { kind: 'unavailable' })).toBe(false)
  })
})

describe('resolveWorkflowsPublicUrl', () => {
  it('accepts a distinct HTTPS hostname and explicit distinct loopback development', () => {
    expect(
      resolveWorkflowsPublicUrl(
        'https://n8n.example.net/editor/',
        'https://api.notes.example.com',
        'https://notes.example.com',
      ),
    ).toBe('https://n8n.example.net/editor/')
    expect(resolveWorkflowsPublicUrl('http://127.0.0.1:5678', 'http://localhost:3000', 'http://localhost:3001')).toBe(
      'http://127.0.0.1:5678/',
    )
  })

  it('rejects the actual browser or API hostname regardless of port', () => {
    expect(
      resolveWorkflowsPublicUrl(
        'https://notes.example.com:8443',
        'https://api.notes.example.com',
        'https://notes.example.com:443',
      ),
    ).toBeNull()
    expect(
      resolveWorkflowsPublicUrl(
        'https://api.notes.example.com:8443',
        'https://api.notes.example.com:443',
        'https://notes.example.com',
      ),
    ).toBeNull()
    expect(
      resolveWorkflowsPublicUrl('http://localhost:5678', 'http://localhost:3000', 'http://localhost:3001'),
    ).toBeNull()
  })

  it.each([
    'http://n8n.example.com',
    '//n8n.example.com',
    'javascript:alert(1)',
    'https://user:secret@n8n.example.com',
    'https://n8n.example.com/?token=secret',
    'https://n8n.example.com/#fragment',
    'https://n8n%2eexample.com',
    'https://n8n.example.com.:8443',
    'https://0177.0.0.1',
    'https://2130706433',
    ' https://n8n.example.com',
    `https://n8n.example.com/${'x'.repeat(2_100)}`,
  ])('rejects unsafe navigation target %s', (value) => {
    expect(resolveWorkflowsPublicUrl(value, 'https://api.notes.example.com', 'https://notes.example.com')).toBeNull()
  })
})

describe('parseWorkflowsStatus', () => {
  it('parses the external-service contract', () => {
    expect(
      parseWorkflowsStatus({
        enabled: true,
        available: true,
        publicUrl: 'https://n8n.example.net/',
        configurationError: false,
        authentication: 'n8n',
      }),
    ).toEqual({
      enabled: true,
      available: true,
      publicUrl: 'https://n8n.example.net/',
      configurationError: false,
      authentication: 'n8n',
    })
  })

  it('rejects old proxy/pairing and internally inconsistent contracts', () => {
    expect(parseWorkflowsStatus({ enabled: true, paired: true, editorUrl: '/workflows-ui/' })).toBeNull()
    expect(
      parseWorkflowsStatus({
        enabled: true,
        available: false,
        publicUrl: 'https://n8n.example.net/',
        configurationError: true,
        authentication: 'n8n',
      }),
    ).toBeNull()
    expect(
      parseWorkflowsStatus({
        enabled: true,
        available: true,
        publicUrl: 'https://n8n.example.net/',
        configurationError: true,
        authentication: 'n8n',
      }),
    ).toBeNull()
    expect(
      parseWorkflowsStatus({
        enabled: true,
        available: false,
        publicUrl: null,
        configurationError: false,
        authentication: 'n8n',
      }),
    ).toBeNull()
    expect(parseWorkflowsStatus({})).toBeNull()
    expect(parseWorkflowsStatus(null)).toBeNull()
  })
})

describe('openExternalWorkflowsUrl', () => {
  it('treats a null handle as valid noopener behavior and never infers that the popup failed', () => {
    const openWindow = jest.fn(() => null)

    expect(openExternalWorkflowsUrl('https://n8n.example.net/', openWindow)).toBeUndefined()
    expect(openWindow).toHaveBeenCalledWith('https://n8n.example.net/', '_blank', 'noopener,noreferrer')
  })
})

describe('WorkflowsStatusService', () => {
  it('does not publish a stale response after an account/session reset', async () => {
    type JsonResponse = { ok: boolean; data: unknown }
    const deferred = () => {
      let resolve!: (value: JsonResponse) => void
      const promise = new Promise<JsonResponse>((resolver) => {
        resolve = resolver
      })
      return { promise, resolve }
    }
    const previousRequest = deferred()
    const currentRequest = deferred()
    const application = (request: Promise<JsonResponse>) =>
      ({
        sessions: { isSignedIn: () => true },
        serverGetJsonRequest: () => request,
      }) as unknown as WebApplication

    const service = new WorkflowsStatusService()
    const previousRefresh = service.refresh(application(previousRequest.promise))
    service.reset()
    const currentRefresh = service.refresh(application(currentRequest.promise))

    currentRequest.resolve({
      ok: true,
      data: {
        enabled: false,
        available: false,
        publicUrl: null,
        configurationError: false,
        authentication: 'n8n',
      },
    })
    await currentRefresh

    previousRequest.resolve({
      ok: true,
      data: {
        enabled: true,
        available: true,
        publicUrl: 'https://previous-user-n8n.example.net/',
        configurationError: false,
        authentication: 'n8n',
      },
    })
    await previousRefresh

    expect(service.get()).toEqual({
      kind: 'loaded',
      status: {
        enabled: false,
        available: false,
        publicUrl: null,
        configurationError: false,
        authentication: 'n8n',
      },
    })
  })

  it('invalidates an in-flight response when the current session is signed out', async () => {
    let resolve!: (value: { ok: boolean; data: unknown }) => void
    const request = new Promise<{ ok: boolean; data: unknown }>((resolver) => {
      resolve = resolver
    })
    const service = new WorkflowsStatusService()
    const signedInApplication = {
      sessions: { isSignedIn: () => true },
      serverGetJsonRequest: () => request,
    } as unknown as WebApplication
    const signedOutApplication = {
      sessions: { isSignedIn: () => false },
    } as unknown as WebApplication

    const pendingRefresh = service.refresh(signedInApplication)
    await service.refresh(signedOutApplication)
    resolve({
      ok: true,
      data: {
        enabled: true,
        available: true,
        publicUrl: 'https://previous-user-n8n.example.net/',
        configurationError: false,
        authentication: 'n8n',
      },
    })
    await pendingRefresh

    expect(service.get()).toEqual({ kind: 'unavailable' })
  })
})
