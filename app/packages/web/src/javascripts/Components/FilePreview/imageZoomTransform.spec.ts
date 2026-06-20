import {
  centerTransform,
  clampScale,
  fitTransform,
  IDENTITY_TRANSFORM,
  imageToScreen,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  panBy,
  screenToImage,
  touchDistance,
  wheelDeltaToFactor,
  zoomByFactor,
  zoomToPoint,
} from './imageZoomTransform'

describe('imageZoomTransform', () => {
  describe('clampScale', () => {
    it('clamps below the minimum', () => {
      expect(clampScale(0.001)).toBe(MIN_IMAGE_SCALE)
    })

    it('clamps above the maximum', () => {
      expect(clampScale(9999)).toBe(MAX_IMAGE_SCALE)
    })

    it('passes through an in-range value', () => {
      expect(clampScale(2)).toBe(2)
    })

    it('respects custom bounds', () => {
      expect(clampScale(5, 1, 3)).toBe(3)
      expect(clampScale(0, 1, 3)).toBe(1)
    })

    it('falls back to the minimum for NaN', () => {
      expect(clampScale(Number.NaN)).toBe(MIN_IMAGE_SCALE)
    })
  })

  describe('screen<->image round trip', () => {
    it('maps screen to image and back to the same point', () => {
      const transform = { scale: 2, offsetX: 30, offsetY: -10 }
      const img = screenToImage(transform, 100, 50)
      expect(img).toEqual({ x: 35, y: 30 })
      const screen = imageToScreen(transform, img.x, img.y)
      expect(screen.x).toBeCloseTo(100)
      expect(screen.y).toBeCloseTo(50)
    })

    it('is the identity under the identity transform', () => {
      expect(screenToImage(IDENTITY_TRANSFORM, 7, 9)).toEqual({ x: 7, y: 9 })
      expect(imageToScreen(IDENTITY_TRANSFORM, 7, 9)).toEqual({ x: 7, y: 9 })
    })
  })

  describe('zoomToPoint', () => {
    it('keeps the anchor point visually fixed', () => {
      const before = { scale: 1, offsetX: 0, offsetY: 0 }
      const anchorX = 120
      const anchorY = 80
      const imgBefore = screenToImage(before, anchorX, anchorY)

      const after = zoomToPoint(before, 3, anchorX, anchorY)
      expect(after.scale).toBe(3)

      // The same image point should now land back under the anchor.
      const screenAfter = imageToScreen(after, imgBefore.x, imgBefore.y)
      expect(screenAfter.x).toBeCloseTo(anchorX)
      expect(screenAfter.y).toBeCloseTo(anchorY)
    })

    it('clamps the resulting scale', () => {
      const after = zoomToPoint({ scale: 1, offsetX: 0, offsetY: 0 }, 9999, 10, 10)
      expect(after.scale).toBe(MAX_IMAGE_SCALE)
    })
  })

  describe('zoomByFactor', () => {
    it('multiplies the scale', () => {
      const after = zoomByFactor({ scale: 2, offsetX: 0, offsetY: 0 }, 1.5, 0, 0)
      expect(after.scale).toBeCloseTo(3)
    })

    it('keeps the anchor fixed while multiplying', () => {
      const before = { scale: 1.5, offsetX: 20, offsetY: 5 }
      const imgBefore = screenToImage(before, 200, 150)
      const after = zoomByFactor(before, 2, 200, 150)
      const screenAfter = imageToScreen(after, imgBefore.x, imgBefore.y)
      expect(screenAfter.x).toBeCloseTo(200)
      expect(screenAfter.y).toBeCloseTo(150)
    })
  })

  describe('panBy', () => {
    it('adds the delta to the offset and leaves scale untouched', () => {
      expect(panBy({ scale: 2, offsetX: 10, offsetY: 20 }, 5, -7)).toEqual({
        scale: 2,
        offsetX: 15,
        offsetY: 13,
      })
    })
  })

  describe('fitTransform', () => {
    it('scales a large image down to fit and centres it', () => {
      const t = fitTransform(200, 100, 400, 100)
      expect(t.scale).toBe(0.5)
      // width 400*0.5 = 200 -> fills horizontally, centred vertically.
      expect(t.offsetX).toBe(0)
      expect(t.offsetY).toBe(25)
    })

    it('never upscales a small image past 1:1', () => {
      const t = fitTransform(800, 600, 100, 100)
      expect(t.scale).toBe(1)
      expect(t.offsetX).toBe(350)
      expect(t.offsetY).toBe(250)
    })

    it('returns identity for degenerate sizes', () => {
      expect(fitTransform(0, 0, 100, 100)).toEqual(IDENTITY_TRANSFORM)
      expect(fitTransform(100, 100, 0, 0)).toEqual(IDENTITY_TRANSFORM)
    })
  })

  describe('centerTransform', () => {
    it('centres the image at the given scale', () => {
      const t = centerTransform(200, 200, 100, 100, 1)
      expect(t).toEqual({ scale: 1, offsetX: 50, offsetY: 50 })
    })
  })

  describe('wheelDeltaToFactor', () => {
    it('zooms in for negative delta (scroll up)', () => {
      expect(wheelDeltaToFactor(-100)).toBeGreaterThan(1)
    })

    it('zooms out for positive delta (scroll down)', () => {
      expect(wheelDeltaToFactor(100)).toBeLessThan(1)
    })

    it('is neutral for zero delta', () => {
      expect(wheelDeltaToFactor(0)).toBeCloseTo(1)
    })
  })

  describe('touchDistance', () => {
    it('computes euclidean distance', () => {
      expect(touchDistance(0, 0, 3, 4)).toBe(5)
    })
  })
})
