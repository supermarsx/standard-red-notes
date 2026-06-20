import { PayloadEmitSource } from '@standardnotes/snjs'
import {
  initialPreferenceSyncState,
  PreferenceSyncState,
  reducePreferenceSync,
} from './usePreferenceSyncToast'

/**
 * Drive a sequence of prefs-item emits through the reducer and collect every
 * toast outcome it decides to emit, returning the final state too.
 */
const run = (
  steps: Array<{ source: PayloadEmitSource; stillDirty?: boolean }>,
  start: PreferenceSyncState = initialPreferenceSyncState,
) => {
  let state = start
  const emitted: string[] = []
  for (const step of steps) {
    const result = reducePreferenceSync(state, step.source, step.stillDirty ?? false)
    state = result.state
    if (result.emit) {
      emitted.push(result.emit)
    }
  }
  return { state, emitted }
}

describe('reducePreferenceSync', () => {
  it('toasts "synced" once after a user change is saved to the server', () => {
    const { emitted } = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
    ])
    expect(emitted).toEqual(['synced'])
  })

  it('collapses a burst of changes into a single synced toast (debounce of pending flag)', () => {
    const { emitted } = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
    ])
    expect(emitted).toEqual(['synced'])
  })

  it('does not toast for a remote save that the user did not initiate (no pending change)', () => {
    const { emitted } = run([{ source: PayloadEmitSource.RemoteSaved, stillDirty: false }])
    expect(emitted).toEqual([])
  })

  it('does not toast on hydration / load sources', () => {
    const { emitted } = run([
      { source: PayloadEmitSource.InitialObserverRegistrationPush },
      { source: PayloadEmitSource.LocalDatabaseLoaded },
      { source: PayloadEmitSource.LocalRetrieved },
      { source: PayloadEmitSource.RemoteRetrieved },
      { source: PayloadEmitSource.PreSyncSave },
    ])
    expect(emitted).toEqual([])
  })

  it('shows the honest "saved-locally" variant when the change is only persisted offline', () => {
    const { emitted } = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.OfflineSyncSaved },
    ])
    expect(emitted).toEqual(['saved-locally'])
  })

  it('does not claim "synced" while the prefs item is still dirty after a remote save', () => {
    // A RemoteSaved that left the item dirty (further unsynced changes) should
    // not yet confirm — the pending flag stays set for the next save.
    const first = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: true },
    ])
    expect(first.emitted).toEqual([])
    expect(first.state.pendingChange).toBe(true)

    // The follow-up clean save then confirms.
    const second = run([{ source: PayloadEmitSource.RemoteSaved, stillDirty: false }], first.state)
    expect(second.emitted).toEqual(['synced'])
  })

  it('clears the pending flag after toasting so a later unrelated remote save is silent', () => {
    const { state, emitted } = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
    ])
    expect(emitted).toEqual(['synced'])
    expect(state.pendingChange).toBe(false)
  })

  it('handles change -> change -> save by emitting one synced toast', () => {
    const { emitted } = run([
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
      { source: PayloadEmitSource.LocalChanged },
      { source: PayloadEmitSource.RemoteSaved, stillDirty: false },
    ])
    expect(emitted).toEqual(['synced', 'synced'])
  })
})
