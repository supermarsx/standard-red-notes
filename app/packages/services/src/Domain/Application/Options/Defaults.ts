import { ApplicationDisplayOptions, ApplicationSyncOptions } from './OptionalOptions'

export interface ApplicationOptionsWhichHaveDefaults {
  loadBatchSize: ApplicationSyncOptions['loadBatchSize']
  sleepBetweenBatches: ApplicationSyncOptions['sleepBetweenBatches']
  lazyDecryptEnabled: ApplicationSyncOptions['lazyDecryptEnabled']
  allowNoteSelectionStatePersistence: ApplicationDisplayOptions['allowNoteSelectionStatePersistence']
  allowMultipleSelection: ApplicationDisplayOptions['allowMultipleSelection']
}

export const ApplicationOptionsDefaults: ApplicationOptionsWhichHaveDefaults = {
  loadBatchSize: 700,
  sleepBetweenBatches: 10,
  /** DEFAULT OFF: zero-risk to ship. Toggle on per-application to enable lazy decrypt. */
  lazyDecryptEnabled: false,
  allowMultipleSelection: true,
  allowNoteSelectionStatePersistence: true,
}
