import { injectable } from 'inversify'
import { Role } from '../Domain/Role/Role'

import { ProjectorInterface } from './ProjectorInterface'

@injectable()
export class RoleProjector implements ProjectorInterface<Role> {
  projectSimple(role: Role): Record<string, unknown> {
    return {
      uuid: role.uuid,
      name: role.name,
    }
  }
}
