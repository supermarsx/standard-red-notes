/**
 * Standard Red Notes: minimal ambient typings for the Shape Detection API's
 * BarcodeDetector, which is not yet part of lib.dom. Availability must be
 * feature-detected at runtime ('BarcodeDetector' in window).
 * https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector
 */

interface DetectedBarcode {
  readonly boundingBox: DOMRectReadOnly
  readonly cornerPoints: ReadonlyArray<{ x: number; y: number }>
  readonly format: string
  readonly rawValue: string
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] })
  static getSupportedFormats(): Promise<string[]>
  detect(source: ImageBitmapSource | HTMLVideoElement): Promise<DetectedBarcode[]>
}
