import { WorkflowsService } from './WorkflowsService'

describe('WorkflowsService', () => {
  const baseConfig = {
    enabled: true,
    publicUrl: 'https://env-n8n.example.net',
    applicationPublicUrl: 'https://notes.example.com',
    cookieDomain: 'notes.example.com',
  }

  it('uses the runtime overlay but still applies app-host and cookie-domain isolation', async () => {
    const service = new WorkflowsService(baseConfig, {
      resolveWorkflowsConfig: async () => ({
        enabled: true,
        publicUrl: 'https://automation.example.net',
      }),
    })

    await expect(service.resolveLink()).resolves.toEqual({
      enabled: true,
      publicUrl: 'https://automation.example.net/',
      configurationError: false,
    })

    const cookieScoped = new WorkflowsService(
      { ...baseConfig, cookieDomain: 'example.net' },
      {
        resolveWorkflowsConfig: async () => ({
          enabled: true,
          publicUrl: 'https://automation.example.net',
        }),
      },
    )
    await expect(cookieScoped.resolveLink()).resolves.toEqual({
      enabled: true,
      publicUrl: null,
      configurationError: true,
    })
  })

  it('fails closed instead of exposing a boot fallback when runtime resolution throws', async () => {
    const service = new WorkflowsService(baseConfig, {
      resolveWorkflowsConfig: async () => {
        throw new Error('settings unavailable')
      },
    })

    await expect(service.resolveLink()).resolves.toEqual({
      enabled: false,
      publicUrl: null,
      configurationError: false,
    })
  })

  it('applies the canonical app-host and cookie-domain policy before an admin save', () => {
    const service = new WorkflowsService({
      ...baseConfig,
      applicationPublicUrl: 'https://notes.srn.test',
      cookieDomain: '.srn.test',
    })

    expect(service.validateConfiguredPublicUrl('https://notes.srn.test:8443')).toMatchObject({ valid: false })
    expect(service.validateConfiguredPublicUrl('https://automation.srn.test')).toMatchObject({ valid: false })
    expect(service.validateConfiguredPublicUrl('https://automation.example.net')).toEqual({
      valid: true,
      url: 'https://automation.example.net/',
    })
  })

  it('rejects an admin save when canonical PUBLIC_URL is missing', () => {
    const service = new WorkflowsService({
      ...baseConfig,
      applicationPublicUrl: null,
    })

    expect(service.validateConfiguredPublicUrl('https://automation.example.net')).toEqual({
      valid: false,
      message: 'Canonical PUBLIC_URL is missing or invalid; configure it before saving workflows.publicUrl.',
    })
  })

  it('does not require a public URL while the operator gate is disabled', async () => {
    const service = new WorkflowsService({
      ...baseConfig,
      enabled: false,
      publicUrl: null,
      applicationPublicUrl: null,
    })

    await expect(service.resolveLink()).resolves.toEqual({
      enabled: false,
      publicUrl: null,
      configurationError: false,
    })
  })
})
