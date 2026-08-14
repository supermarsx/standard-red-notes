import { PrefKey, PrefValue } from '@standardnotes/models'
import { AbstractService } from '../Service/AbstractService'
import { LocalPrefKey, LocalPrefValue } from './LocalPrefKey'

export enum PreferencesServiceEvent {
  LocalPreferencesChanged = 'LocalPreferencesChanged',
  PreferencesChanged = 'PreferencesChanged',
}

export type LocalPreferenceWriteOptions = {
  /**
   * Implicit writes repair/default the device cache and must not outrank an
   * already-synced user choice. Calls without an option are explicit user or
   * application changes and retain the existing behavior.
   */
  source?: 'user' | 'implicit'
}

export interface PreferenceServiceInterface extends AbstractService<PreferencesServiceEvent> {
  getValue<K extends PrefKey>(key: K, defaultValue: PrefValue[K]): PrefValue[K]
  getValue<K extends PrefKey>(key: K, defaultValue?: PrefValue[K]): PrefValue[K] | undefined
  getValue<K extends PrefKey>(key: K, defaultValue: PrefValue[K] | undefined): PrefValue[K] | undefined

  getLocalValue<K extends LocalPrefKey>(key: K, defaultValue: LocalPrefValue[K]): LocalPrefValue[K]
  getLocalValue<K extends LocalPrefKey>(key: K, defaultValue?: LocalPrefValue[K]): LocalPrefValue[K] | undefined
  getLocalValue<K extends LocalPrefKey>(
    key: K,
    defaultValue: LocalPrefValue[K] | undefined,
  ): LocalPrefValue[K] | undefined

  setValue<K extends PrefKey>(key: K, value: PrefValue[K]): Promise<void>
  /** Set value without triggering sync or event notifications */
  setValueDetached<K extends PrefKey>(key: K, value: PrefValue[K]): Promise<void>
  setLocalValue<K extends LocalPrefKey>(key: K, value: LocalPrefValue[K], options?: LocalPreferenceWriteOptions): void
}
