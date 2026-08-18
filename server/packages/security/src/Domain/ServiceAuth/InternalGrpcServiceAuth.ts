import { createHmac, timingSafeEqual } from 'crypto'

export const INTERNAL_GRPC_AUTH_VERSION = 'v1'
export const INTERNAL_GRPC_AUTH_REPLAY_WINDOW_MILLISECONDS = 60_000

export const INTERNAL_GRPC_AUTH_METADATA = {
  version: 'x-sync-service-auth-version',
  timestamp: 'x-sync-service-auth-timestamp',
  signature: 'x-sync-service-auth-signature',
} as const

export type InternalGrpcAuthMethod = 'syncItems' | 'getSyncCommandStatus'

export type InternalGrpcAuthScope = {
  method: InternalGrpcAuthMethod
  userUuid: string
  sessionUuid?: string | null
  commandId: string
  commandDigest?: string
  bodyDigest?: string
}

export type InternalGrpcAuthProof = {
  version: string
  timestamp: string
  signature: string
}

export type InternalGrpcAuthVerification = 'valid' | 'unconfigured' | 'invalid' | 'stale'

export class InternalGrpcServiceAuth {
  constructor(
    private readonly secret: string | undefined,
    private readonly now: () => number = Date.now,
    private readonly replayWindowMilliseconds = INTERNAL_GRPC_AUTH_REPLAY_WINDOW_MILLISECONDS,
  ) {}

  ready(): boolean {
    return typeof this.secret === 'string' && Buffer.byteLength(this.secret, 'utf8') >= 32
  }

  sign(scope: InternalGrpcAuthScope): InternalGrpcAuthProof {
    if (!this.ready()) {
      throw new Error('Internal gRPC service authentication is not configured.')
    }

    const timestamp = String(this.now())
    return {
      version: INTERNAL_GRPC_AUTH_VERSION,
      timestamp,
      signature: this.signature(scope, INTERNAL_GRPC_AUTH_VERSION, timestamp),
    }
  }

  verify(scope: InternalGrpcAuthScope, proof: Partial<InternalGrpcAuthProof>): InternalGrpcAuthVerification {
    if (!this.ready()) {
      return 'unconfigured'
    }
    if (
      proof.version !== INTERNAL_GRPC_AUTH_VERSION ||
      typeof proof.timestamp !== 'string' ||
      !/^\d+$/.test(proof.timestamp) ||
      typeof proof.signature !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(proof.signature)
    ) {
      return 'invalid'
    }

    const timestamp = Number(proof.timestamp)
    if (!Number.isSafeInteger(timestamp) || Math.abs(this.now() - timestamp) > this.replayWindowMilliseconds) {
      return 'stale'
    }

    const expected = Buffer.from(this.signature(scope, proof.version, proof.timestamp), 'hex')
    const presented = Buffer.from(proof.signature, 'hex')

    return expected.length === presented.length && timingSafeEqual(expected, presented) ? 'valid' : 'invalid'
  }

  private signature(scope: InternalGrpcAuthScope, version: string, timestamp: string): string {
    const message = [
      version,
      scope.method,
      timestamp,
      scope.userUuid,
      scope.sessionUuid ?? '',
      scope.commandId,
      scope.commandDigest?.toLowerCase() ?? '',
      scope.bodyDigest?.toLowerCase() ?? '',
    ].join('\n')

    return createHmac('sha256', this.secret as string)
      .update(message, 'utf8')
      .digest('hex')
  }
}
