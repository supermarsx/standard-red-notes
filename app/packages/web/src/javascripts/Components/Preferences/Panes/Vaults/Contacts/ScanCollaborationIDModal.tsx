import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/Components/Modal/Modal'
import Icon from '@/Components/Icon/Icon'
import { collaborationIDFromQRPayload } from '@/Utils/CollaborationIDQR'

/**
 * Standard Red Notes: returns true when the browser can decode QR codes via
 * the Shape Detection API (BarcodeDetector). Feature-detected: when
 * unsupported the scan affordances are hidden entirely and the paste field
 * remains the only input, as before.
 */
export async function isQRScanningSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
    return false
  }
  try {
    const formats = await BarcodeDetector.getSupportedFormats()
    return formats.includes('qr_code')
  } catch {
    return false
  }
}

type Props = {
  onScan: (collaborationID: string) => void
  close: () => void
}

type CameraStatus = 'initializing' | 'active' | 'unavailable'

const DetectIntervalMs = 300

const ScanCollaborationIDModal: FunctionComponent<Props> = ({ onScan, close }) => {
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('initializing')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const didCompleteRef = useRef(false)

  const handleDetectedBarcodes = useCallback(
    (barcodes: DetectedBarcode[]): boolean => {
      for (const barcode of barcodes) {
        const collaborationID = collaborationIDFromQRPayload(barcode.rawValue)
        if (collaborationID) {
          if (!didCompleteRef.current) {
            didCompleteRef.current = true
            onScan(collaborationID)
          }
          return true
        }
      }
      if (barcodes.length > 0) {
        setErrorMessage('The scanned QR code is not a valid CollaborationID.')
      }
      return false
    },
    [onScan],
  )

  useEffect(() => {
    let stream: MediaStream | undefined
    let intervalId: number | undefined
    let disposed = false

    const detector = new BarcodeDetector({ formats: ['qr_code'] })

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
      } catch {
        if (!disposed) {
          setCameraStatus('unavailable')
        }
        return
      }

      if (disposed || !videoRef.current) {
        stream?.getTracks().forEach((track) => track.stop())
        return
      }

      const video = videoRef.current
      video.srcObject = stream
      await video.play().catch(() => undefined)

      if (disposed) {
        return
      }

      setCameraStatus('active')

      intervalId = window.setInterval(() => {
        if (didCompleteRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          return
        }
        detector
          .detect(video)
          .then(handleDetectedBarcodes)
          .catch(() => undefined)
      }, DetectIntervalMs)
    }

    void start()

    return () => {
      disposed = true
      if (intervalId !== undefined) {
        window.clearInterval(intervalId)
      }
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [handleDetectedBarcodes])

  const handleUploadedImage = useCallback(
    async (file: File) => {
      setErrorMessage(undefined)
      try {
        const bitmap = await createImageBitmap(file)
        const detector = new BarcodeDetector({ formats: ['qr_code'] })
        const barcodes = await detector.detect(bitmap)
        bitmap.close()
        if (barcodes.length === 0) {
          setErrorMessage('No QR code was found in the selected image.')
          return
        }
        handleDetectedBarcodes(barcodes)
      } catch {
        setErrorMessage('Unable to read the selected image.')
      }
    },
    [handleDetectedBarcodes],
  )

  return (
    <Modal
      title="Scan CollaborationID QR Code"
      close={close}
      actions={[
        {
          label: 'Upload Image',
          onClick: () => fileInputRef.current?.click(),
          type: 'secondary',
        },
        {
          label: 'Cancel',
          onClick: close,
          type: 'cancel',
          mobileSlot: 'left',
        },
      ]}
    >
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="text-sm">
          Point your camera at a contact's CollaborationID QR code, or upload a saved image of one.
        </div>
        {cameraStatus !== 'unavailable' ? (
          <div className="relative w-full overflow-hidden rounded-md bg-contrast">
            <video ref={videoRef} className="max-h-80 w-full object-contain" muted playsInline />
            {cameraStatus === 'initializing' && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-base">
                <Icon type="camera" className="text-neutral-300" />
                Starting camera...
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-contrast px-3 py-3 text-sm">
            <Icon type="camera" className="flex-shrink-0 text-neutral-300" />
            Camera is unavailable. You can still upload an image of the QR code below.
          </div>
        )}
        {errorMessage && <div className="text-sm text-danger">{errorMessage}</div>}
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void handleUploadedImage(file)
            }
            event.target.value = ''
          }}
        />
      </div>
    </Modal>
  )
}

export default ScanCollaborationIDModal
