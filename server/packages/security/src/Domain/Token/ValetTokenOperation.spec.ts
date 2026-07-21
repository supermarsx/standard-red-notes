import { ValetTokenOperation } from './ValetTokenOperation'

describe('ValetTokenOperation', () => {
  it('should serialize each operation to the wire value embedded in valet tokens', () => {
    expect(ValetTokenOperation.Read).toEqual('read')
    expect(ValetTokenOperation.Write).toEqual('write')
    expect(ValetTokenOperation.Delete).toEqual('delete')
    expect(ValetTokenOperation.Move).toEqual('move')
  })

  it('should expose exactly the four permitted operations', () => {
    expect(Object.values(ValetTokenOperation).sort()).toEqual(['delete', 'move', 'read', 'write'])
  })

  it('should be keyed by operation name only, so a wire value is never itself a valid key', () => {
    expect(Object.keys(ValetTokenOperation).sort()).toEqual(['Delete', 'Move', 'Read', 'Write'])
    expect(Object.keys(ValetTokenOperation)).not.toContain('read')
  })
})
