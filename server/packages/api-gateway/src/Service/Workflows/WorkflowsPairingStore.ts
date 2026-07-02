import { promises as fs } from 'fs'
import * as path from 'path'

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
 * the feature self-contained inside api-gateway (which has no database). Writes
 * are chained + atomic (tmp file + rename), mirroring CaldavTokenStore.
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

export class WorkflowsPairingStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(userUuid: string): Promise<WorkflowsPairing | null> {
    const data = await this.read()
    return data[userUuid] ?? null
  }

  async isPaired(userUuid: string): Promise<boolean> {
    return (await this.get(userUuid)) !== null
  }

  /** Idempotent: pairing an already-paired user keeps the original record. */
  async pair(userUuid: string): Promise<WorkflowsPairing> {
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
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreShape
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const data = await this.read()
      mutator(data)
      await this.atomicWrite(data)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async atomicWrite(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
