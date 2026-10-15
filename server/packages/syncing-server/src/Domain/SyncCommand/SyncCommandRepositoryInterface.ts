import { SyncCommandStatus } from './SyncCommandTypes'

export type StoredSyncCommand = {
  uuid: string
  userUuid: string
  sessionUuid: string
  commandId: string
  requestDigest: string
  status: SyncCommandStatus
  responseJson: string | null
  expiresAtTimestamp: number
  createdAtTimestamp?: number
}

export interface SyncCommandRepositoryInterface {
  insertAcceptedIfAbsent(command: StoredSyncCommand): Promise<void>
  find(userUuid: string, sessionUuid: string, commandId: string): Promise<StoredSyncCommand | null>
  claimAccepted(uuid: string, executionToken: string): Promise<boolean>
  commit(uuid: string, executionToken: string, responseJson: string, expiresAtTimestamp: number): Promise<void>
  /**
   * Remove the acceptance of a command whose execution failed, if it is still accepted and
   * no execution holds it. Returns whether a row was removed.
   */
  deleteAcceptedIfUnclaimed(
    userUuid: string,
    sessionUuid: string,
    commandId: string,
    acceptedBeforeTimestamp?: number,
  ): Promise<boolean>
  deleteExpired(nowTimestamp: number): Promise<number>
}
