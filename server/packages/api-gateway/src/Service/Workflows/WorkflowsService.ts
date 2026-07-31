import {
  validateWorkflowsPublicUrl,
  WorkflowsPublicUrlValidation,
  workflowsPublicUrlErrorMessage,
} from './WorkflowsPublicUrl'

/**
 * Minimal read seam over the gateway's runtime server-settings resolver.
 */
export interface WorkflowsConfigResolver {
  resolveWorkflowsConfig(): Promise<{
    enabled: boolean
    publicUrl: string | null
  }>
}

export interface WorkflowsServiceConfig {
  /** Operator master switch. Off means the link is undiscoverable. */
  enabled: boolean
  /**
   * Browser-facing n8n URL. This is navigation metadata only: the gateway never
   * proxies, fetches, authenticates to, or appends credentials to this URL.
   */
  publicUrl: string | null
  /** Canonical Standard Red Notes public URL used for hostname isolation. */
  applicationPublicUrl: string | null
  /** Auth cookie Domain from SRN; empty means a host-only cookie. */
  cookieDomain?: string | null
}

export interface ResolvedWorkflowsLink {
  enabled: boolean
  publicUrl: string | null
  configurationError: boolean
}

export type WorkflowsConfiguredPublicUrlValidation = { valid: true; url: string } | { valid: false; message: string }

/**
 * Exposes a strictly validated, separately authenticated n8n link.
 *
 * Standard Red Notes account gating controls only whether the link is visible
 * to a user. n8n remains a separate security domain and performs its own login,
 * session management, authorization, project isolation, and credential storage.
 */
export class WorkflowsService {
  constructor(
    private readonly config: WorkflowsServiceConfig,
    private readonly resolver?: WorkflowsConfigResolver,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled
  }

  async resolvedEnabled(): Promise<boolean> {
    return (await this.resolvedConfig()).enabled
  }

  /**
   * Resolve and validate the external navigation target against the configured
   * canonical PUBLIC_URL. Request Host headers are never a policy input.
   */
  async resolveLink(): Promise<ResolvedWorkflowsLink> {
    const config = await this.resolvedConfig()
    if (!config.enabled) {
      return { enabled: false, publicUrl: null, configurationError: false }
    }
    const validation = this.validateConfiguredPublicUrl(config.publicUrl)
    if (!validation.valid) {
      return { enabled: true, publicUrl: null, configurationError: true }
    }
    return { enabled: true, publicUrl: validation.url, configurationError: false }
  }

  /**
   * Validate a value before persisting it through the admin API. This uses the
   * exact same canonical app-origin and cookie-domain policy as link discovery,
   * so the API cannot save a value that status would immediately withhold.
   */
  validateConfiguredPublicUrl(publicUrl: unknown): WorkflowsConfiguredPublicUrlValidation {
    const applicationUrl = validateWorkflowsPublicUrl(this.config.applicationPublicUrl)
    if (!applicationUrl.valid) {
      return {
        valid: false,
        message: 'Canonical PUBLIC_URL is missing or invalid; configure it before saving workflows.publicUrl.',
      }
    }
    const validation = this.validate(publicUrl, applicationUrl.url)
    if (!validation.valid) {
      return { valid: false, message: workflowsPublicUrlErrorMessage(validation.error) }
    }
    return validation
  }

  validate(publicUrl: unknown, applicationOrigin?: string | null): WorkflowsPublicUrlValidation {
    return validateWorkflowsPublicUrl(publicUrl, {
      applicationOrigin,
      forbiddenCookieDomain: this.config.cookieDomain,
    })
  }

  private async resolvedConfig(): Promise<WorkflowsServiceConfig> {
    if (!this.resolver) {
      return this.config
    }
    try {
      return {
        ...(await this.resolver.resolveWorkflowsConfig()),
        applicationPublicUrl: this.config.applicationPublicUrl,
        cookieDomain: this.config.cookieDomain,
      }
    } catch {
      // An unexpected resolver failure must not re-enable discovery from a
      // looser boot fallback after an administrator disabled it.
      return { ...this.config, enabled: false, publicUrl: null }
    }
  }
}
