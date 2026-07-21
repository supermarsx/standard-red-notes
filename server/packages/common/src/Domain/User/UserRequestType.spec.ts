import { UserRequestType } from './UserRequestType'

describe('UserRequestType', () => {
  it('should serialize the exit discount request to its wire value', () => {
    expect(UserRequestType.ExitDiscount).toEqual('exit-discount')
  })

  it('should expose exactly one supported user request type', () => {
    expect(Object.values(UserRequestType)).toEqual(['exit-discount'])
  })
})
