import { Email, Username, Uuid } from '@standardnotes/domain-core'

import { ReadStream } from 'fs'
import { User } from './User'

export interface UserRepositoryInterface {
  streamAll(): Promise<ReadStream>
  streamTeam(memberEmail?: Email): Promise<ReadStream>
  findOneByUuid(uuid: Uuid): Promise<User | null>
  findOneByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User | null>
  findAllByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User[]>
  /**
   * Standard Red Notes: resolves a single account by the composite
   * (email, workspace_identifier). Used only when WORKSPACES_PER_EMAIL_ENABLED
   * is ON to disambiguate which workspace an email maps to. With the flag OFF
   * this method is never called; callers use findOneByUsernameOrEmail as before.
   */
  findOneByEmailAndWorkspaceIdentifier(
    usernameOrEmail: Email | Username,
    workspaceIdentifier: string,
  ): Promise<User | null>
  findAllCreatedBetween(dto: { start: Date; end: Date; offset: number; limit: number }): Promise<User[]>
  countAllCreatedBetween(start: Date, end: Date): Promise<number>
  save(user: User): Promise<User>
  remove(user: User): Promise<User>
}
