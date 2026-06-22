import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Group } from './Group'

export interface GroupRepositoryInterface {
  findAll(): Promise<Group[]>
  findById(id: UniqueEntityId): Promise<Group | null>
  findByName(name: string): Promise<Group | null>
  /**
   * Returns the groups a given user is a member of (resolved via the
   * `rbac_user_groups` join table).
   */
  findByUserUuid(userUuid: Uuid): Promise<Group[]>
  save(group: Group): Promise<void>
  remove(group: Group): Promise<void>
  addUser(groupId: UniqueEntityId, userUuid: Uuid): Promise<void>
  removeUser(groupId: UniqueEntityId, userUuid: Uuid): Promise<void>
  /**
   * Returns the user uuids that are members of the given group.
   */
  findMemberUuids(groupId: UniqueEntityId): Promise<string[]>
}
