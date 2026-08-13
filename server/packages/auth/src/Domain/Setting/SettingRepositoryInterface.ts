import { SettingName } from '@standardnotes/domain-core'

import { DeleteSettingDto } from '../UseCase/DeleteSetting/DeleteSettingDto'
import { Setting } from './Setting'

export interface SettingRepositoryInterface {
  findOneByUuid(uuid: string): Promise<Setting | null>
  findOneByUuidAndNames(uuid: string, names: SettingName[]): Promise<Setting | null>
  findOneByNameAndUserUuid(name: string, userUuid: string): Promise<Setting | null>
  findLastByNameAndUserUuid(name: string, userUuid: string): Promise<Setting | null>
  findAllByUserUuid(userUuid: string): Promise<Setting[]>
  countAllByNameAndValue(dto: { name: SettingName; value: string }): Promise<number>
  countAllByName(name: SettingName): Promise<number>
  // Standard Red Notes: like countAllByNameAndValue but restricted to rows OWNED
  // by a user holding the given role. Used by Register to consult the instance-wide
  // REGISTRATION_DISABLED flag while ignoring any row not owned by an admin, so a
  // non-admin can never disable registration by persisting the flag on their own
  // record (see the CLIENT_IMMUTABLE_SETTINGS note in SettingsAssociationService).
  countAllByNameAndValueOwnedByRole(dto: { name: SettingName; value: string; roleName: string }): Promise<number>
  findAllByNameAndValue(dto: { name: SettingName; value: string; offset: number; limit: number }): Promise<Setting[]>
  findAllByName(dto: { name: SettingName; offset: number; limit: number }): Promise<Setting[]>
  deleteByUserUuid(dto: DeleteSettingDto): Promise<void>
  insert(setting: Setting): Promise<void>
  update(setting: Setting): Promise<void>
}
