import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { McpTokenProps } from './McpTokenProps'

export class McpToken extends Entity<McpTokenProps> {
  private constructor(props: McpTokenProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: McpTokenProps, id?: UniqueEntityId): Result<McpToken> {
    if (props.label.length === 0) {
      return Result.fail<McpToken>('MCP token label cannot be empty')
    }

    if (props.label.length > 255) {
      return Result.fail<McpToken>('MCP token label cannot be longer than 255 characters')
    }

    if (props.scope !== 'read' && props.scope !== 'write') {
      return Result.fail<McpToken>('MCP token scope must be either read or write')
    }

    return Result.ok<McpToken>(new McpToken(props, id))
  }
}
