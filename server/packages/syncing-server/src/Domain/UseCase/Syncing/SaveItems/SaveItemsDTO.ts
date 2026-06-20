import { ItemHash } from '../../../Item/ItemHash'

export interface SaveItemsDTO {
  itemHashes: ItemHash[]
  userUuid: string
  apiVersion: string
  readOnlyAccess: boolean
  sessionUuid: string | null
  snjsVersion: string
  isFreeUser: boolean
  hasContentLimit: boolean
  // Standard Red Notes: when false, suppress the realtime websocket push to the
  // user's own clients. The save itself still succeeds. Default true.
  liveSyncEnabled: boolean
}
