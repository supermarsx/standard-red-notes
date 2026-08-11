import { ChangeEditorFunction, registerLatestChangeEditorFunction } from './ChangeContentCallback'

describe('ChangeContentCallback registration', () => {
  it('clears an unmounted callback without allowing stale cleanup to clear its replacement', () => {
    const target: { current: ChangeEditorFunction | undefined } = { current: undefined }
    const oldEditor = jest.fn()
    const newEditor = jest.fn()

    const disposeOld = registerLatestChangeEditorFunction(target, oldEditor)
    const disposeNew = registerLatestChangeEditorFunction(target, newEditor)
    disposeOld()

    expect(target.current).toBe(newEditor)
    disposeNew()
    expect(target.current).toBeUndefined()
  })
})
