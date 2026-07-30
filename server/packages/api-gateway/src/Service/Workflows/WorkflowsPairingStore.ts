import {
  hasOnlyKeys,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'

/**
 * Standard Red Notes: per-user WORKFLOWS pairing records.
 *
 * "Paired" means the user has explicitly clicked "Connect workflows" while
 * entitled (WORKFLOWS_ENABLED env + admin-managed per-user WorkflowsEnabled
 * setting), and only entitled+paired users may reach the embedded n8n editor
 * through the authenticated gateway proxy. The record itself carries NO secret —
 * it is a gate marker plus provisioning bookkeeping for later phases (n8n
 * credential/webhook references get recorded here when Phase 2 wires them).
 *
 * STORAGE: a single JSON file, like the CalDAV token/published stores, keeping
 * the feature self-contained inside api-gateway (which has no database). The
 * shared secure-file primitive bounds and validates reads, rejects unsafe
 * link/type targets, and serializes durable atomic writes across local store
 * instances.
 */

export interface WorkflowsPairing {
  userUuid: string
  pairedAt: number
  /**
   * Phase 2 bookkeeping (all null in Phase 1):
   * - mcpTokenUuid: reference to the scoped MCP token minted for n8n->SRN calls
   *   (never the token itself — the plaintext lives only inside n8n as a
   *   credential). Minting requires client-side wrapped key material, so it is
   *   deferred to the client-driven pairing step.
   * - webhookUuids: SRN webhooks registered to point at the user's n8n triggers.
   */
  mcpTokenUuid: string | null
  webhookUuids: string[] | null
}

interface StoreShape {
  // userUuid -> pairing record
  [userUuid: string]: WorkflowsPairing
}

const MAX_PAIRINGS = 10_000
const MAX_RESOURCE_ID_LENGTH = 512
const MAX_WEBHOOKS_PER_PAIRING = 10_000

function isPairing(value: unknown, userUuid: string): value is WorkflowsPairing {
  return (
    hasOnlyKeys(value, ['userUuid', 'pairedAt', 'mcpTokenUuid', 'webhookUuids']) &&
    isSafeRecordKey(userUuid) &&
    value.userUuid === userUuid &&
    isEpochMilliseconds(value.pairedAt) &&
    (value.mcpTokenUuid === null || isSafeRecordKey(value.mcpTokenUuid, MAX_RESOURCE_ID_LENGTH)) &&
    (value.webhookUuids === null ||
      (Array.isArray(value.webhookUuids) &&
        value.webhookUuids.length <= MAX_WEBHOOKS_PER_PAIRING &&
        value.webhookUuids.every((webhookUuid) => isSafeRecordKey(webhookUuid, MAX_RESOURCE_ID_LENGTH))))
  )
}

function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return entries.length <= MAX_PAIRINGS && entries.every(([userUuid, pairing]) => isPairing(pairing, userUuid))
}

export class WorkflowsPairingStore {
  private readonly store: SecureJsonFileStore<StoreShape>

  constructor(filePath: string) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
  }

  async get(userUuid: string): Promise<WorkflowsPairing | null> {
    if (!isSafeRecordKey(userUuid)) {
      return null
    }
    const data = await this.read()
    return data[userUuid] ?? null
  }

  async isPaired(userUuid: string): Promise<boolean> {
    return (await this.get(userUuid)) !== null
  }

  /** Idempotent: pairing an already-paired user keeps the original record. */
  async pair(userUuid: string): Promise<WorkflowsPairing> {
    if (!isSafeRecordKey(userUuid)) {
      throw new Error('A valid user identifier is required to pair workflows.')
    }
    let pairing: WorkflowsPairing | undefined
    await this.mutate((data) => {
      if (!data[userUuid]) {
        data[userUuid] = {
          userUuid,
          pairedAt: Date.now(),
          mcpTokenUuid: null,
          webhookUuids: null,
        }
      }
      pairing = data[userUuid]
    })
    return pairing as WorkflowsPairing
  }

  /** Idempotent: returns true when a record was actually removed. */
  async unpair(userUuid: string): Promise<boolean> {
    if (!isSafeRecordKey(userUuid)) {
      return false
    }
    let removed = false
    await this.mutate((data) => {
      if (data[userUuid]) {
        delete data[userUuid]
        removed = true
      }
    })
    return removed
  }

  private async read(): Promise<StoreShape> {
    return (await this.store.read()) ?? {}
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    await this.store.update((current) => {
      const data = current ?? {}
      mutator(data)
      return data
    })
  }
}
