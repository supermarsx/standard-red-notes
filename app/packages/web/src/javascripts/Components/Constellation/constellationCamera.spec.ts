import {
  Camera,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  screenToWorld,
  worldToScreen,
  zoomToward,
  zoomByFactor,
  wheelDeltaToFactor,
} from './constellationCamera'

describe('clampScale', () => {
  it('clamps below the minimum', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE)
  })
  it('clamps above the maximum', () => {
    expect(clampScale(99)).toBe(MAX_SCALE)
  })
  it('passes through values in range', () => {
    expect(clampScale(1.5)).toBe(1.5)
  })
})

describe('screenToWorld / worldToScreen round-trip', () => {
  const cameras: Camera[] = [
    { x: 0, y: 0, scale: 1 },
    { x: 200, y: 150, scale: 1 },
    { x: 200, y: 150, scale: 2.5 },
    { x: -40, y: 75, scale: 0.3 },
  ]

  it('is the inverse of itself for every camera', () => {
    for (const camera of cameras) {
      for (const [sx, sy] of [
        [0, 0],
        [123, 456],
        [-50, 320],
      ]) {
        const world = screenToWorld(camera, sx, sy)
        const back = worldToScreen(camera, world.x, world.y)
        expect(back.x).toBeCloseTo(sx, 6)
        expect(back.y).toBeCloseTo(sy, 6)
      }
    }
  })

  it('maps a node at the world origin to the camera offset', () => {
    const camera = { x: 200, y: 150, scale: 2 }
    expect(worldToScreen(camera, 0, 0)).toEqual({ x: 200, y: 150 })
  })
})

describe('zoomToward', () => {
  it('keeps the world point under the anchor fixed', () => {
    const camera = { x: 200, y: 150, scale: 1 }
    const anchorX = 300
    const anchorY = 250
    const worldBefore = screenToWorld(camera, anchorX, anchorY)

    const zoomed = zoomToward(camera, 2.5, anchorX, anchorY)
    const screenAfter = worldToScreen(zoomed, worldBefore.x, worldBefore.y)

    expect(screenAfter.x).toBeCloseTo(anchorX, 6)
    expect(screenAfter.y).toBeCloseTo(anchorY, 6)
    expect(zoomed.scale).toBe(2.5)
  })

  it('clamps the requested scale', () => {
    const camera = { x: 0, y: 0, scale: 1 }
    expect(zoomToward(camera, 1000, 10, 10).scale).toBe(MAX_SCALE)
    expect(zoomToward(camera, 0.0001, 10, 10).scale).toBe(MIN_SCALE)
  })

  it('does not mutate the input camera', () => {
    const camera = { x: 5, y: 6, scale: 1 }
    const copy = { ...camera }
    zoomToward(camera, 2, 0, 0)
    expect(camera).toEqual(copy)
  })

  it('returns an unchanged-scale copy when already clamped at the max', () => {
    const camera = { x: 10, y: 20, scale: MAX_SCALE }
    const result = zoomToward(camera, MAX_SCALE * 2, 50, 50)
    expect(result).toEqual(camera)
    expect(result).not.toBe(camera)
  })
})

describe('zoomByFactor', () => {
  it('zooming in then out by reciprocal factors restores the camera', () => {
    const camera = { x: 200, y: 150, scale: 1 }
    const inOnce = zoomByFactor(camera, 1.5, 300, 250)
    const out = zoomByFactor(inOnce, 1 / 1.5, 300, 250)
    expect(out.scale).toBeCloseTo(camera.scale, 6)
    expect(out.x).toBeCloseTo(camera.x, 6)
    expect(out.y).toBeCloseTo(camera.y, 6)
  })
})

describe('wheelDeltaToFactor', () => {
  it('returns >1 when scrolling up (negative deltaY) to zoom in', () => {
    expect(wheelDeltaToFactor(-100)).toBeGreaterThan(1)
  })
  it('returns <1 when scrolling down (positive deltaY) to zoom out', () => {
    expect(wheelDeltaToFactor(100)).toBeLessThan(1)
  })
  it('returns 1 for no movement', () => {
    expect(wheelDeltaToFactor(0)).toBe(1)
  })
})
