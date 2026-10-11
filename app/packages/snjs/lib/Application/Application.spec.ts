import { Environment, Platform } from '@standardnotes/models'
import { SNApplication } from './Application'
import { SNLog } from '../Log'

/**
 * *** WHY THIS TINY FILE EXISTS. ***
 *
 * A production deployment served a CSP that refused the inline bootstrap in
 * `app/packages/web/src/index.html` — the only thing that sets `window.defaultSyncServer`.
 * `App.tsx` passes it into `startApplication` typed `string` with no fallback, and
 * `WebApplication` forwards it as `defaultHost`, so the suspicion was a half-initialised
 * sync transport that then failed inside its pre-sync recovery.
 *
 * There is no such half-initialised state to be in. `defaultHost` is a REQUIRED option,
 * checked before anything is wired, so a blocked bootstrap does not produce a degraded
 * app with a broken transport: it produces NO app — which is exactly the white screen
 * the dev server showed under the same refused script. An app that is running and
 * logging sync-transport lines therefore had a host, whatever the CSP did to the script
 * that usually supplies it.
 *
 * Only the refusing cases are exercised. Getting past these checks wires the whole
 * dependency graph, which is not what this is about.
 */
describe('SNApplication required options', () => {
  const baseOptions = () => ({
    environment: Environment.Web,
    platform: Platform.LinuxWeb,
    deviceInterface: {} as never,
    crypto: {} as never,
    alertService: {} as never,
    identifier: 'required-options-spec',
    appVersion: '1.0.0',
    apiVersion: '20240226',
  })

  beforeEach(() => {
    SNLog.onLog = () => undefined
    SNLog.onError = () => undefined
  })

  afterEach(() => {
    ;(SNLog.onLog as unknown) = undefined
    ;(SNLog.onError as unknown) = undefined
  })

  it('refuses to construct an application with no sync host, rather than degrading into one', () => {
    expect(() => new SNApplication({ ...baseOptions(), defaultHost: undefined } as never)).toThrow(
      'defaultHost must be supplied when creating an application.',
    )
    // The key being absent is the same thing as the bootstrap never having run.
    expect(() => new SNApplication(baseOptions() as never)).toThrow(
      'defaultHost must be supplied when creating an application.',
    )
    // An empty host would make every request resolve same-origin and look plausible,
    // so it is refused too and does not reach the API service.
    expect(() => new SNApplication({ ...baseOptions(), defaultHost: '' } as never)).toThrow(
      'defaultHost must be supplied when creating an application.',
    )
  })
})
