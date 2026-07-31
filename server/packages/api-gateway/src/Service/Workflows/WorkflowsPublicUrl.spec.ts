import { validateWorkflowsPublicUrl, workflowsPublicUrlErrorMessage } from './WorkflowsPublicUrl'

describe('validateWorkflowsPublicUrl', () => {
  it.each([
    ['https://n8n.example.com', 'https://n8n.example.com/'],
    ['https://n8n.example.com/automation/', 'https://n8n.example.com/automation/'],
    ['https://n8n.example.com:8443', 'https://n8n.example.com:8443/'],
    ['http://localhost:5678', 'http://localhost:5678/'],
    ['http://127.0.0.1:5678', 'http://127.0.0.1:5678/'],
    ['http://[::1]:5678', 'http://[::1]:5678/'],
  ])('accepts %s as %s', (value, expected) => {
    expect(validateWorkflowsPublicUrl(value)).toEqual({ valid: true, url: expected })
  })

  it.each([
    ['', 'required'],
    [' https://n8n.example.com', 'surrounding-whitespace'],
    ['https://n8n.example.com ', 'surrounding-whitespace'],
    ['//n8n.example.com', 'invalid-url'],
    ['javascript:alert(1)', 'invalid-url'],
    ['file:///tmp/n8n', 'invalid-url'],
    ['https://user:secret@n8n.example.com', 'credentials'],
    ['https://n8n.example.com/?token=secret', 'query'],
    ['https://n8n.example.com/#editor', 'fragment'],
    ['http://n8n.example.com', 'insecure'],
    ['http://n8n:5678', 'insecure'],
    ['https://n8n.example.com.', 'unsafe-authority'],
    ['https://n8n.example.com.:8443', 'unsafe-authority'],
    ['https://n8n%2eexample.com', 'unsafe-authority'],
    ['https://0177.0.0.1', 'unsafe-authority'],
    ['https://2130706433', 'unsafe-authority'],
    ['https:\\\\n8n.example.com', 'control-character'],
    ['https://n8n.example.com/\nsecond', 'control-character'],
  ])('rejects unsafe value %s with %s', (value, error) => {
    expect(validateWorkflowsPublicUrl(value)).toEqual({ valid: false, error })
  })

  it('rejects the Standard Red Notes hostname across ports but permits a distinct hostname', () => {
    expect(
      validateWorkflowsPublicUrl('https://notes.example.com/workflows', {
        applicationOrigin: 'https://notes.example.com',
      }),
    ).toEqual({ valid: false, error: 'same-host' })
    expect(
      validateWorkflowsPublicUrl('https://notes.example.com:8443', {
        applicationOrigin: 'https://notes.example.com:443',
      }),
    ).toEqual({ valid: false, error: 'same-host' })
    expect(
      validateWorkflowsPublicUrl('https://n8n.example.com', {
        applicationOrigin: 'https://notes.example.com',
      }),
    ).toEqual({ valid: true, url: 'https://n8n.example.com/' })
  })

  it('rejects targets that would receive a configured domain-scoped SRN auth cookie', () => {
    expect(
      validateWorkflowsPublicUrl('https://n8n.example.com', {
        applicationOrigin: 'https://notes.example.com',
        forbiddenCookieDomain: '.example.com',
      }),
    ).toEqual({ valid: false, error: 'cookie-domain' })
    expect(
      validateWorkflowsPublicUrl('https://automation.example.net', {
        applicationOrigin: 'https://notes.example.com',
        forbiddenCookieDomain: 'example.com',
      }),
    ).toEqual({ valid: true, url: 'https://automation.example.net/' })
  })

  it('fails closed when the configured cookie domain is malformed', () => {
    expect(
      validateWorkflowsPublicUrl('https://automation.example.net', {
        forbiddenCookieDomain: 'example.com:443',
      }),
    ).toEqual({ valid: false, error: 'invalid-cookie-domain' })
  })

  it('fails closed for overlong values and provides safe operator messages', () => {
    const result = validateWorkflowsPublicUrl(`https://n8n.example.com/${'x'.repeat(2_100)}`)
    expect(result).toEqual({ valid: false, error: 'too-long' })
    if (!result.valid) {
      expect(workflowsPublicUrlErrorMessage(result.error)).not.toContain('x'.repeat(100))
    }
  })
})
