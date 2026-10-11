import { ItemStorageUsage } from '../../../Item/ItemStorageUsage'

/**
 * Standard Red Notes: one account's stored-item measurement WITH the uuid it is a
 * measurement of.
 *
 * *** THE UUID TRAVELS WITH THE FIGURE, AND THAT IS THE POINT OF THIS TYPE. ***
 * The defect this use case exists to close was a report that answered the CALLER's
 * own figure for every account it was asked about — three accounts holding 3 MB,
 * 7 MB and 11 MB of notes all read 3 MB, because the only route that published the
 * measurement took its subject from the session and ignored the account named in
 * the request. A bare number cannot be checked against the account it is printed
 * beside; a number that carries its subject can, and the admin pane refuses any
 * entry naming a user it did not ask about.
 */
export type UserItemStorageUsage = ItemStorageUsage & {
  userUuid: string
}
