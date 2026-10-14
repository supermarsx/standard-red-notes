/** @jest-environment jsdom */
describe('collaboration device identity', () => {
  beforeEach(() => {
    jest.resetModules()
    localStorage.clear()
  })

  it('shares a profile identity across module/page reloads', () => {
    const first = require('./CollaborationDeviceIdentity').collaborationDeviceId()
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    jest.resetModules()
    expect(require('./CollaborationDeviceIdentity').collaborationDeviceId()).toBe(first)
  })

  it('replaces invalid stored values', () => {
    localStorage.setItem('standardnotes.collaboration-device-id.v1', '<untrusted>')
    expect(require('./CollaborationDeviceIdentity').collaborationDeviceId()).toMatch(/^[a-f0-9]{32}$/)
  })

  it('reports no device identity when storage cannot coordinate tabs', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(require('./CollaborationDeviceIdentity').collaborationDeviceId()).toBeUndefined()
  })
})
