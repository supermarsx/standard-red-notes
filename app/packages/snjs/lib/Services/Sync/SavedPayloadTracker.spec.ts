import { DecryptedPayloadInterface } from '@standardnotes/models'
import { SavedPayloadTracker } from './SavedPayloadTracker'

const payload = (text: string) => ({ uuid: 'note', content: { text } }) as DecryptedPayloadInterface

describe('SavedPayloadTracker', () => {
  it('acknowledges the exact submitted snapshot despite newer edits and out-of-order responses', () => {
    const tracker = new SavedPayloadTracker()
    const listener = jest.fn()
    tracker.subscribe('note', listener)
    const first = payload('first')
    const second = payload('second')
    const upload1 = { uuid: 'note' }
    const upload2 = { uuid: 'note' }
    tracker.prepare(first, upload1)
    tracker.prepare(second, upload2)
    tracker.acknowledge([upload2], [{ uuid: 'note' }], jest.fn())
    tracker.acknowledge([upload1], [{ uuid: 'note' }], jest.fn())
    expect(listener.mock.calls.map(([value]) => value)).toEqual([second, first])
    tracker.acknowledge([upload1], [{ uuid: 'note' }], jest.fn())
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('never treats conflicts, unknown uploads, or unobserved snapshots as acknowledgements', () => {
    const tracker = new SavedPayloadTracker()
    const ignored = { uuid: 'note' }
    tracker.prepare(payload('unobserved'), ignored)
    const listener = jest.fn()
    tracker.subscribe('note', listener)
    const conflicted = { uuid: 'note' }
    tracker.prepare(payload('conflict'), conflicted)
    tracker.acknowledge([conflicted], [{ uuid: 'other' }], jest.fn())
    tracker.acknowledge([ignored, { uuid: 'note' }], [{ uuid: 'note' }], jest.fn())
    expect(listener).not.toHaveBeenCalled()
  })

  it('retains uploads until their page is acknowledged', () => {
    const tracker = new SavedPayloadTracker()
    const listener = jest.fn()
    tracker.subscribe('note', listener)
    const upload = { uuid: 'note' }
    const original = payload('later page')
    tracker.prepare(original, upload)
    tracker.acknowledge([upload], [{ uuid: 'other' }], jest.fn())
    tracker.acknowledge([upload], [{ uuid: 'note' }], jest.fn())
    expect(listener).toHaveBeenCalledWith(original)
  })

  it('isolates observers and clears pending plaintext on teardown', () => {
    const tracker = new SavedPayloadTracker()
    const failure = new Error('observer')
    const unsubscribe = tracker.subscribe('note', () => {
      throw failure
    })
    const listener = jest.fn()
    tracker.subscribe('note', listener)
    const upload = { uuid: 'note' }
    tracker.prepare(payload('saved'), upload)
    const onError = jest.fn()
    tracker.acknowledge([upload], [{ uuid: 'note' }], onError)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    tracker.prepare(payload('pending'), upload)
    tracker.clear()
    tracker.subscribe('note', listener)
    tracker.acknowledge([upload], [{ uuid: 'note' }], onError)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
