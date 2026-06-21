import { WebApplication } from '@/Application/WebApplication'
import { shouldRunDiaryCheck } from './useDiaryScheduler'
import { getDiarySettings } from './diaryService'
import { DEFAULT_DIARY_SETTINGS } from './diary'

/**
 * Standard Red Notes: LAUNCH-GUARD for the boot-time diary scheduler.
 *
 * `useDiaryScheduler` mounts in `ApplicationView`, which can render BEFORE the
 * app finishes launching. Its tick reads diary settings via `getDiarySettings`,
 * which calls `application.getValue` — and that THROWS "before loading local
 * storage" if called pre-launch. The crash that prompted this audit was exactly
 * that: the scheduler reading storage during launch.
 *
 * The guard is `shouldRunDiaryCheck(application)`, returning `application.isLaunched()`.
 * These tests pin the contract:
 *  - it is false before launch (so the tick bails out before touching storage),
 *  - it is true after launch,
 *  - a pre-launch read path does NOT invoke `getValue` (so it cannot throw).
 */

describe('shouldRunDiaryCheck — launch guard', () => {
  it('is false while the app has not launched', () => {
    const application = { isLaunched: () => false } as unknown as WebApplication
    expect(shouldRunDiaryCheck(application)).toBe(false)
  })

  it('is true once the app has launched', () => {
    const application = { isLaunched: () => true } as unknown as WebApplication
    expect(shouldRunDiaryCheck(application)).toBe(true)
  })
})

describe('scheduler tick gating — getValue is never read before launch', () => {
  /**
   * Mirrors the tick's exact guard order: bail on `!shouldRunDiaryCheck`, else
   * read settings. We assert `getValue` is untouched pre-launch and read post.
   */
  const runGatedTick = (application: WebApplication): void => {
    if (!shouldRunDiaryCheck(application)) {
      return
    }
    getDiarySettings(application)
  }

  it('does not call getValue when the app is not launched', () => {
    const getValue = jest.fn(() => {
      throw new Error('Attempting to get storage key DiaryMode before loading local storage.')
    })
    const application = {
      isLaunched: () => false,
      getValue,
    } as unknown as WebApplication

    expect(() => runGatedTick(application)).not.toThrow()
    expect(getValue).not.toHaveBeenCalled()
  })

  it('calls getValue once the app is launched', () => {
    const getValue = jest.fn(() => undefined)
    const application = {
      isLaunched: () => true,
      getValue,
    } as unknown as WebApplication

    runGatedTick(application)
    expect(getValue).toHaveBeenCalledWith('DiaryMode')
  })

  it('still does not throw post-launch even if getValue itself throws the early-load error', () => {
    // Defense in depth: even past the guard, the getter swallows the throw.
    const application = {
      isLaunched: () => true,
      getValue: () => {
        throw new Error('Attempting to get storage key DiaryMode before loading local storage.')
      },
    } as unknown as WebApplication

    expect(() => getDiarySettings(application)).not.toThrow()
    expect(getDiarySettings(application)).toEqual(DEFAULT_DIARY_SETTINGS)
  })
})
