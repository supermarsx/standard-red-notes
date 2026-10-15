import { AppDataField, DefaultAppDomain } from '@standardnotes/models'

type Payload = {
  uuid: string
  content_type: string
  content?: unknown
  deleted?: boolean
  updated_at_timestamp?: number
}
type Snapshot = { value: string; timestamp: number }

/** Local-only comparisons: no plaintext or content fingerprint leaves this device. */
function snapshot(payload: Payload): string | undefined {
  if (payload.deleted || payload.content_type !== 'Note' || !payload.content || typeof payload.content !== 'object') {
    return undefined
  }
  const content = payload.content as Record<string, unknown>
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sort)
    }
    if (!value || typeof value !== 'object') {
      return value
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    )
  }
  try {
    const appData =
      content.appData && typeof content.appData === 'object'
        ? { ...(content.appData as Record<string, unknown>) }
        : content.appData
    if (appData && typeof appData === 'object') {
      const operational = new Set<string>([
        AppDataField.UserModifiedDate,
        AppDataField.CollaborationRevision,
        AppDataField.Pinned,
        AppDataField.Archived,
        AppDataField.Locked,
        AppDataField.LastSize,
        AppDataField.MobileActive,
      ])
      const domain = (appData as Record<string, unknown>)[DefaultAppDomain]
      if (domain && typeof domain === 'object') {
        ;(appData as Record<string, unknown>)[DefaultAppDomain] = Object.fromEntries(
          Object.entries(domain).filter(([key]) => !operational.has(key)),
        )
      }
    }
    const value = JSON.stringify(sort({ title: content.title, text: content.text, appData }))
    return value.length <= 65_536 ? value : undefined
  } catch {
    return undefined
  }
}

export class RevisionChangeTracker {
  private readonly baselines = new Map<string, Snapshot>()
  private pending = new WeakMap<object, string>()
  observe(payload: Payload): void {
    const value = snapshot(payload)
    if (value !== undefined) {
      this.remember(payload.uuid, value, payload.updated_at_timestamp ?? 0)
    } else if (payload.deleted) {
      this.baselines.delete(payload.uuid)
    }
  }
  prepare(payload: Payload, upload: object): 'automatic' | 'metadata' | undefined {
    if (payload.content_type !== 'Note' || payload.deleted) {
      return undefined
    }
    const value = snapshot(payload)
    if (value === undefined) {
      return 'automatic'
    }
    this.pending.set(upload, value)
    return this.baselines.get(payload.uuid)?.value === value ? 'metadata' : 'automatic'
  }
  acknowledge(uploads: Array<Payload & object>, saved: Array<{ uuid: string; updated_at_timestamp?: number }>): void {
    const timestamps = new Map(saved.map((payload) => [payload.uuid, payload.updated_at_timestamp ?? 0]))
    for (const upload of uploads) {
      const value = this.pending.get(upload)
      if (value !== undefined && timestamps.has(upload.uuid)) {
        this.remember(upload.uuid, value, timestamps.get(upload.uuid)!)
        this.pending.delete(upload)
      }
    }
  }
  private remember(uuid: string, value: string, timestamp: number): void {
    if ((this.baselines.get(uuid)?.timestamp ?? -1) > timestamp) {
      return
    }
    this.baselines.delete(uuid)
    this.baselines.set(uuid, { value, timestamp })
    if (this.baselines.size > 128) {
      this.baselines.delete(this.baselines.keys().next().value!)
    }
  }
  clear(): void {
    this.baselines.clear()
    this.pending = new WeakMap()
  }
}
