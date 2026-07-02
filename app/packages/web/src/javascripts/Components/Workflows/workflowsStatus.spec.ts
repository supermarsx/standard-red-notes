import {
  WorkflowsStatusState,
  parseWorkflowsStatus,
  resolveWorkflowsEditorUrl,
  shouldShowWorkflowsSection,
} from './workflowsStatus'

/**
 * Standard Red Notes — Workflows visibility + URL resolution (pure helpers).
 *
 * The sidebar Workflows button must render ONLY when the user is signed into a
 * server AND GET /v1/workflows/status reports enabled=true. Every degraded
 * state (loading, endpoint 404 / not deployed, signed out, enabled=false)
 * resolves to hidden. The editor URL resolver joins the server-relative
 * editorUrl with the API host and rejects unsafe values so the sandboxed
 * iframe can never be pointed at an unexpected origin or scheme.
 */

const loaded = (enabled: boolean, paired = false, editorUrl: string | null = null): WorkflowsStatusState => ({
  kind: 'loaded',
  status: { enabled, paired, editorUrl },
})

describe('shouldShowWorkflowsSection', () => {
  it('is visible only when signed in and the loaded status has enabled=true', () => {
    expect(shouldShowWorkflowsSection(true, loaded(true))).toBe(true)
    expect(shouldShowWorkflowsSection(true, loaded(true, true, '/workflows-ui/'))).toBe(true)
  })

  it('is hidden when signed out, even with an enabled status cached', () => {
    expect(shouldShowWorkflowsSection(false, loaded(true))).toBe(false)
  })

  it('is hidden when the feature is disabled for the account', () => {
    expect(shouldShowWorkflowsSection(true, loaded(false))).toBe(false)
  })

  it('is hidden for every non-loaded state (unknown / loading / unavailable)', () => {
    expect(shouldShowWorkflowsSection(true, { kind: 'unknown' })).toBe(false)
    expect(shouldShowWorkflowsSection(true, { kind: 'loading' })).toBe(false)
    expect(shouldShowWorkflowsSection(true, { kind: 'unavailable' })).toBe(false)
  })
})

describe('resolveWorkflowsEditorUrl', () => {
  it('joins a server-relative editorUrl with the API host', () => {
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', '/workflows-ui/')).toBe(
      'https://notes.example.com/workflows-ui/',
    )
  })

  it('strips trailing slashes from the host before joining', () => {
    expect(resolveWorkflowsEditorUrl('https://notes.example.com/', '/workflows-ui/')).toBe(
      'https://notes.example.com/workflows-ui/',
    )
  })

  it('passes through absolute http(s) URLs', () => {
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', 'https://n8n.example.com/editor')).toBe(
      'https://n8n.example.com/editor',
    )
  })

  it('returns null when there is no editorUrl', () => {
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', null)).toBeNull()
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', '')).toBeNull()
  })

  it('rejects protocol-relative, schemeful, and non-rooted values', () => {
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', '//evil.example.com/editor')).toBeNull()
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', 'javascript:alert(1)')).toBeNull()
    expect(resolveWorkflowsEditorUrl('https://notes.example.com', 'workflows-ui')).toBeNull()
  })

  it('returns null for a relative path when no host is known (never resolves against the web origin)', () => {
    expect(resolveWorkflowsEditorUrl(undefined, '/workflows-ui/')).toBeNull()
    expect(resolveWorkflowsEditorUrl('', '/workflows-ui/')).toBeNull()
  })
})

describe('parseWorkflowsStatus', () => {
  it('parses a contract-shaped body', () => {
    expect(parseWorkflowsStatus({ enabled: true, paired: true, editorUrl: '/workflows-ui/' })).toEqual({
      enabled: true,
      paired: true,
      editorUrl: '/workflows-ui/',
    })
  })

  it('normalizes missing/odd optional fields', () => {
    expect(parseWorkflowsStatus({ enabled: false })).toEqual({ enabled: false, paired: false, editorUrl: null })
    expect(parseWorkflowsStatus({ enabled: true, paired: 'yes', editorUrl: 42 })).toEqual({
      enabled: true,
      paired: false,
      editorUrl: null,
    })
  })

  it('rejects non-contract bodies (404 pages, empty objects, non-objects)', () => {
    expect(parseWorkflowsStatus(undefined)).toBeNull()
    expect(parseWorkflowsStatus(null)).toBeNull()
    expect(parseWorkflowsStatus('not json')).toBeNull()
    expect(parseWorkflowsStatus({})).toBeNull()
    expect(parseWorkflowsStatus({ error: 'not found' })).toBeNull()
  })
})
