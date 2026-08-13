import { ApiEndpointParam } from './Item/ApiEndpointParam'
import { ConflictType } from './Item/ConflictType'
import { DeprecatedStatusCode } from './Http/DeprecatedStatusCode'
import { ErrorTag } from './Http/ErrorTag'
import { HttpStatusCode } from './Http/HttpStatusCode'
import { HttpVerb } from './Http/HttpVerb'
import { ValetTokenOperation } from './Temp/ValetTokenOperation'

/**
 * These enums are part of the wire contract between clients and the sync/auth servers.
 * Changing any value silently breaks compatibility, so the values are pinned here.
 */
describe('wire constants', () => {
  it('HttpStatusCode should carry the standard numeric codes', () => {
    expect(HttpStatusCode.Success).toBe(200)
    expect(HttpStatusCode.NoContent).toBe(204)
    expect(HttpStatusCode.MultipleChoices).toBe(300)
    expect(HttpStatusCode.BadRequest).toBe(400)
    expect(HttpStatusCode.Unauthorized).toBe(401)
    expect(HttpStatusCode.Forbidden).toBe(403)
    expect(HttpStatusCode.Conflict).toBe(409)
    expect(HttpStatusCode.Gone).toBe(410)
    expect(HttpStatusCode.ExpiredAccessToken).toBe(498)
    expect(HttpStatusCode.InternalServerError).toBe(500)
    expect(HttpStatusCode.ServiceUnavailable).toBe(503)
  })

  it('HttpVerb should map to the uppercase HTTP methods', () => {
    expect(HttpVerb.Get).toBe('GET')
    expect(HttpVerb.Post).toBe('POST')
    expect(HttpVerb.Put).toBe('PUT')
    expect(HttpVerb.Patch).toBe('PATCH')
    expect(HttpVerb.Delete).toBe('DELETE')
  })

  it('DeprecatedStatusCode should keep the legacy success window and session codes', () => {
    expect(DeprecatedStatusCode.LocalValidationError).toBe(10)
    expect(DeprecatedStatusCode.CanceledMfa).toBe(11)
    expect(DeprecatedStatusCode.HttpStatusMinSuccess).toBe(200)
    expect(DeprecatedStatusCode.HttpStatusNoContent).toBe(204)
    expect(DeprecatedStatusCode.HttpStatusMaxSuccess).toBe(299)
    expect(DeprecatedStatusCode.HttpStatusExpiredAccessToken).toBe(498)
    expect(DeprecatedStatusCode.HttpStatusInvalidSession).toBe(401)
    expect(DeprecatedStatusCode.HttpStatusForbidden).toBe(403)
    expect(DeprecatedStatusCode.HttpBadRequest).toBe(400)
  })

  it('DeprecatedStatusCode success window should bracket the modern success codes', () => {
    expect(HttpStatusCode.Success).toBeGreaterThanOrEqual(DeprecatedStatusCode.HttpStatusMinSuccess)
    expect(HttpStatusCode.NoContent).toBeLessThanOrEqual(DeprecatedStatusCode.HttpStatusMaxSuccess)
    expect(HttpStatusCode.BadRequest).toBeGreaterThan(DeprecatedStatusCode.HttpStatusMaxSuccess)
  })

  it('ErrorTag should use the kebab-case tags the auth server emits', () => {
    expect(ErrorTag.MfaInvalid).toBe('mfa-invalid')
    expect(ErrorTag.MfaRequired).toBe('mfa-required')
    expect(ErrorTag.U2FRequired).toBe('u2f-required')
    expect(ErrorTag.ProofOfWorkRequired).toBe('proof-of-work-required')
    expect(ErrorTag.RefreshTokenInvalid).toBe('invalid-refresh-token')
    expect(ErrorTag.RefreshTokenExpired).toBe('expired-refresh-token')
    expect(ErrorTag.AccessTokenExpired).toBe('expired-access-token')
    expect(ErrorTag.ParametersInvalid).toBe('invalid-parameters')
    expect(ErrorTag.RevokedSession).toBe('revoked-session')
    expect(ErrorTag.AuthInvalid).toBe('invalid-auth')
    expect(ErrorTag.ReadOnlyAccess).toBe('read-only-access')
    expect(ErrorTag.ExpiredItemShare).toBe('expired-item-share')
    expect(ErrorTag.ClientValidationError).toBe('client-validation-error')
    expect(ErrorTag.ClientCanceledMfa).toBe('client-canceled-mfa')
  })

  it('ApiEndpointParam should use the snake_case query/body keys the server expects', () => {
    expect(ApiEndpointParam.LastSyncToken).toBe('sync_token')
    expect(ApiEndpointParam.PaginationToken).toBe('cursor_token')
    expect(ApiEndpointParam.SyncDlLimit).toBe('limit')
    expect(ApiEndpointParam.SyncPayloads).toBe('items')
    expect(ApiEndpointParam.ApiVersion).toBe('api')
    expect(ApiEndpointParam.SharedVaultUuids).toBe('shared_vault_uuids')
  })

  it('ConflictType should use the snake_case types returned by the sync endpoint', () => {
    expect(ConflictType.ConflictingData).toBe('sync_conflict')
    expect(ConflictType.UuidConflict).toBe('uuid_conflict')
    expect(ConflictType.ContentTypeError).toBe('content_type_error')
    expect(ConflictType.ContentError).toBe('content_error')
    expect(ConflictType.ReadOnlyError).toBe('readonly_error')
    expect(ConflictType.UuidError).toBe('uuid_error')
    expect(ConflictType.InvalidServerItem).toBe('invalid_server_item')
    expect(ConflictType.SharedVaultSnjsVersionError).toBe('shared_vault_snjs_version_error')
    expect(ConflictType.SharedVaultInsufficientPermissionsError).toBe('shared_vault_insufficient_permissions_error')
    expect(ConflictType.SharedVaultNotMemberError).toBe('shared_vault_not_member_error')
    expect(ConflictType.SharedVaultInvalidState).toBe('shared_vault_invalid_state')
  })

  it('ValetTokenOperation should use the lowercase file operation names', () => {
    expect(ValetTokenOperation.Read).toBe('read')
    expect(ValetTokenOperation.Write).toBe('write')
    expect(ValetTokenOperation.Delete).toBe('delete')
    expect(ValetTokenOperation.Move).toBe('move')
  })
})
