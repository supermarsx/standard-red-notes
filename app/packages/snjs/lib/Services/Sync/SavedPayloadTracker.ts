import { DecryptedPayloadInterface } from '@standardnotes/models'

/** Correlates server acknowledgements with the exact plaintext submitted, not the newer local item. */
export class SavedPayloadTracker {
  private readonly listeners = new Map<string, Set<(payload: DecryptedPayloadInterface) => void>>()
  private pending = new WeakMap<object, DecryptedPayloadInterface>()

  public subscribe(uuid: string, listener: (payload: DecryptedPayloadInterface) => void): () => void {
    const listeners = this.listeners.get(uuid) ?? new Set()
    listeners.add(listener)
    this.listeners.set(uuid, listeners)
    return () => {
      listeners.delete(listener)
      if (this.listeners.get(uuid) === listeners && listeners.size === 0) {
        this.listeners.delete(uuid)
      }
    }
  }

  public prepare(payload: DecryptedPayloadInterface, upload: object): void {
    if (this.listeners.has(payload.uuid)) {
      this.pending.set(upload, payload)
    }
  }

  public acknowledge(
    uploads: readonly { uuid: string }[],
    saved: readonly { uuid: string }[],
    onListenerError: (error: unknown) => void,
  ): void {
    const savedUuids = new Set(saved.map((payload) => payload.uuid))
    for (const upload of uploads) {
      const original = this.pending.get(upload)
      if (!original || !savedUuids.has(upload.uuid)) {
        continue
      }
      this.pending.delete(upload)
      for (const listener of [...(this.listeners.get(upload.uuid) ?? [])]) {
        try {
          listener(original)
        } catch (error) {
          // An observer must never turn an acknowledged save into a failed sync.
          onListenerError(error)
        }
      }
    }
  }

  public clear(): void {
    this.pending = new WeakMap()
    this.listeners.clear()
  }
}
