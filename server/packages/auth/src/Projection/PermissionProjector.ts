import { injectable } from 'inversify'
import { Permission } from '../Domain/Permission/Permission'

import { ProjectorInterface } from './ProjectorInterface'

@injectable()
export class PermissionProjector implements ProjectorInterface<Permission> {
  projectSimple(permission: Permission): Record<string, unknown> {
    return {
      uuid: permission.uuid,
      name: permission.name,
    }
  }
}
