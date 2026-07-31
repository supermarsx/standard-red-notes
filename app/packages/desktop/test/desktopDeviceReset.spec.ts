import test from 'ava'

test('hard reset reloads the renderer without invoking destructive data clearing', async (t) => {
  const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reloadCalls = 0
  let destroyAllDataCalls = 0

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: globalThis,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        reload: () => {
          reloadCalls += 1
        },
      },
    },
  })

  try {
    const { DesktopDevice } = await import('../app/javascripts/Renderer/DesktopDevice')
    const remoteBridge = {
      destroyAllData: async () => {
        destroyAllDataCalls += 1
      },
    }
    const device = new DesktopDevice(remoteBridge as never, false, 'extensions.example.test', 'test-version')

    await device.performHardReset()

    t.is(reloadCalls, 1)
    t.is(destroyAllDataCalls, 0)
  } finally {
    if (selfDescriptor) {
      Object.defineProperty(globalThis, 'self', selfDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'self')
    }
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})
