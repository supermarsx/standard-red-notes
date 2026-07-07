import { FilesApiInterface } from '@standardnotes/files'
import { AbstractService } from '../Service/AbstractService'
import { ApiServiceEvent } from './ApiServiceEvent'
import { ApiServiceEventData } from './ApiServiceEventData'
import { SNFeatureRepo, ServerSyncPushContextualPayload } from '@standardnotes/models'
import { ClientDisplayableError, HttpRequest, HttpResponse } from '@standardnotes/responses'
import { AnyFeatureDescription } from '@standardnotes/features'

export interface LegacyApiServiceInterface
  extends AbstractService<ApiServiceEvent, ApiServiceEventData>, FilesApiInterface {
  setHost(host: string): Promise<void>
  getHost(): string

  downloadOfflineFeaturesFromRepo(dto: {
    repo: SNFeatureRepo
  }): Promise<{ features: AnyFeatureDescription[]; roles: string[] } | ClientDisplayableError>

  downloadFeatureUrl(url: string): Promise<HttpResponse>

  /**
   * Standard Red Notes: fetch the plugins gallery index (`packages.json`) via the
   * same-origin gateway proxy so the strict CSP `connect-src 'self'` is satisfied.
   */
  downloadPluginsIndex(): Promise<HttpResponse>

  /**
   * Standard Red Notes: fetch the client-readable plugins config
   * ({ repoUrl, sameOriginRendering }) used to decide whether to rewrite a
   * trusted-repo component's external `hosted_url` to the same-origin component
   * route so its iframe renders under the strict CSP `frame-src 'self'`.
   */
  downloadPluginsConfig(): Promise<HttpResponse>

  getSyncHttpRequest(
    payloads: ServerSyncPushContextualPayload[],
    lastSyncToken: string | undefined,
    paginationToken: string | undefined,
    limit: number,
    sharedVaultUuids?: string[],
  ): HttpRequest

  getNewSubscriptionToken(): Promise<string | undefined>
}
