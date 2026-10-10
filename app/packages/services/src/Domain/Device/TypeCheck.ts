import { MobileDeviceInterface } from './MobileDeviceInterface'
import { DeviceInterface } from './DeviceInterface'
import { Environment } from '@standardnotes/models'

// Standard Red Notes: a `/* istanbul ignore file */` used to sit here. It is a
// form of coverage exclusion that lives IN THE SOURCE, so no sweep of
// `jest.config.js` / `vitest.config.ts` can see it — and this file was the one
// place in the repo where it hid logic that a spec already covers.
// `TypeCheck.spec.ts` asserts both arms of this guard and runs on every suite;
// the pragma meant no floor could ever see that, so the spec could have been
// deleted and no gate would have moved. Nine lines at 100 % now count toward
// this package's denominator instead of being absent from it.
//
// `isMobileDevice` is a type PREDICATE, which is exactly why it matters: every
// caller narrows on its result, so an inverted comparison here would route
// mobile callers down the desktop path with no type error anywhere.

export function isMobileDevice(x: DeviceInterface): x is MobileDeviceInterface {
  return x.environment === Environment.Mobile
}
