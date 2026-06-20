/**
 * Pure helpers for an image pan/zoom viewport.
 *
 * The viewport keeps a `scale` (1 = the image's natural/fit size) and a
 * translation (`offsetX`, `offsetY`) in screen pixels. The rendered image is
 * conceptually transformed as `translate(offset) scale(scale)` around the
 * top-left of the viewport, so a point in image space maps to screen space as:
 *
 *   screen = offset + image * scale
 *
 * Keeping this math in a small, dependency-free module makes the zoom behaviour
 * (cursor-centred wheel zoom, clamping, fit) trivially unit-testable.
 */

export type ZoomTransform = {
  scale: number
  offsetX: number
  offsetY: number
}

export const MIN_IMAGE_SCALE = 0.1
export const MAX_IMAGE_SCALE = 10

export const IDENTITY_TRANSFORM: ZoomTransform = { scale: 1, offsetX: 0, offsetY: 0 }

export const clampScale = (scale: number, min = MIN_IMAGE_SCALE, max = MAX_IMAGE_SCALE): number => {
  if (Number.isNaN(scale)) {
    return min
  }
  return Math.min(max, Math.max(min, scale))
}

/** Convert a point in screen/viewport coordinates to image coordinates. */
export const screenToImage = (transform: ZoomTransform, screenX: number, screenY: number) => {
  return {
    x: (screenX - transform.offsetX) / transform.scale,
    y: (screenY - transform.offsetY) / transform.scale,
  }
}

/** Convert a point in image coordinates to screen/viewport coordinates. */
export const imageToScreen = (transform: ZoomTransform, imageX: number, imageY: number) => {
  return {
    x: imageX * transform.scale + transform.offsetX,
    y: imageY * transform.scale + transform.offsetY,
  }
}

/**
 * Produce a new transform zoomed to `nextScale` while keeping the point under
 * (`anchorX`, `anchorY`) — given in viewport coordinates — visually fixed. This
 * is what makes wheel-zoom feel like it's centred on the cursor.
 */
export const zoomToPoint = (
  transform: ZoomTransform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
  min = MIN_IMAGE_SCALE,
  max = MAX_IMAGE_SCALE,
): ZoomTransform => {
  const clamped = clampScale(nextScale, min, max)
  // The image-space point under the anchor must stay under the anchor after zoom.
  const imagePoint = screenToImage(transform, anchorX, anchorY)
  return {
    scale: clamped,
    offsetX: anchorX - imagePoint.x * clamped,
    offsetY: anchorY - imagePoint.y * clamped,
  }
}

/**
 * Multiply the current scale by `factor` (e.g. derived from a wheel delta),
 * keeping the anchor point fixed.
 */
export const zoomByFactor = (
  transform: ZoomTransform,
  factor: number,
  anchorX: number,
  anchorY: number,
  min = MIN_IMAGE_SCALE,
  max = MAX_IMAGE_SCALE,
): ZoomTransform => {
  return zoomToPoint(transform, transform.scale * factor, anchorX, anchorY, min, max)
}

/** Apply a pan delta (in screen pixels) to the current transform. */
export const panBy = (transform: ZoomTransform, deltaX: number, deltaY: number): ZoomTransform => {
  return {
    scale: transform.scale,
    offsetX: transform.offsetX + deltaX,
    offsetY: transform.offsetY + deltaY,
  }
}

/**
 * Compute a transform that fits an image of the given natural size centred
 * inside a viewport, never upscaling past 1:1 (so small images aren't blurred).
 */
export const fitTransform = (
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
): ZoomTransform => {
  if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { ...IDENTITY_TRANSFORM }
  }
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight, 1)
  const offsetX = (viewportWidth - imageWidth * scale) / 2
  const offsetY = (viewportHeight - imageHeight * scale) / 2
  return { scale, offsetX, offsetY }
}

/**
 * Re-centre the image inside the viewport at a given scale (used by the reset/
 * fit-to-100% actions and double-click toggling).
 */
export const centerTransform = (
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
  scale: number,
): ZoomTransform => {
  return {
    scale,
    offsetX: (viewportWidth - imageWidth * scale) / 2,
    offsetY: (viewportHeight - imageHeight * scale) / 2,
  }
}

/** Convert a mouse-wheel deltaY into a multiplicative zoom factor. */
export const wheelDeltaToFactor = (deltaY: number, sensitivity = 0.0015): number => {
  // Negative deltaY (scroll up) zooms in.
  return Math.exp(-deltaY * sensitivity)
}

/** Euclidean distance between two touch points, for pinch-zoom. */
export const touchDistance = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  return Math.hypot(ax - bx, ay - by)
}
