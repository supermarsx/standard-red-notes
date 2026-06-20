/**
 * Pure camera / coordinate-transform helpers for the constellation graph.
 *
 * The graph is drawn to a 2D canvas with a simple affine camera:
 *   screen = world * scale + (camera.x, camera.y)
 *   world  = (screen - camera.x) / scale
 *
 * Keeping these as standalone pure functions lets us unit-test the screen<->graph
 * mapping (which must stay correct under zoom+pan so click-to-open hits the right
 * node) without spinning up the canvas/DOM.
 */

export type Camera = { x: number; y: number; scale: number }

/** Minimum / maximum zoom factor. Below MIN the whole graph is a speck; above MAX
 *  individual nodes fill the viewport and labels become huge. */
export const MIN_SCALE = 0.15
export const MAX_SCALE = 4

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Map a screen-space (canvas-local) point to world/graph coordinates. */
export function screenToWorld(camera: Camera, screenX: number, screenY: number): { x: number; y: number } {
  return { x: (screenX - camera.x) / camera.scale, y: (screenY - camera.y) / camera.scale }
}

/** Map a world/graph point back to screen-space (canvas-local) coordinates. */
export function worldToScreen(camera: Camera, worldX: number, worldY: number): { x: number; y: number } {
  return { x: worldX * camera.scale + camera.x, y: worldY * camera.scale + camera.y }
}

/**
 * Zoom the camera toward a fixed screen-space anchor (the cursor, or the midpoint
 * between two pinching fingers). The world point currently under the anchor stays
 * under the anchor after the zoom, which is what makes "zoom toward the pointer"
 * feel natural. `nextScaleRaw` is clamped to [MIN_SCALE, MAX_SCALE].
 *
 * Returns a NEW camera; the input is not mutated.
 */
export function zoomToward(camera: Camera, nextScaleRaw: number, anchorX: number, anchorY: number): Camera {
  const nextScale = clampScale(nextScaleRaw)
  if (nextScale === camera.scale) {
    return { ...camera }
  }
  const ratio = nextScale / camera.scale
  return {
    scale: nextScale,
    x: anchorX - (anchorX - camera.x) * ratio,
    y: anchorY - (anchorY - camera.y) * ratio,
  }
}

/** Apply a multiplicative zoom step (e.g. wheel delta or +/- button) toward an anchor. */
export function zoomByFactor(camera: Camera, factor: number, anchorX: number, anchorY: number): Camera {
  return zoomToward(camera, camera.scale * factor, anchorX, anchorY)
}

/** Convert a wheel `deltaY` into a smooth multiplicative zoom factor. */
export function wheelDeltaToFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015)
}
