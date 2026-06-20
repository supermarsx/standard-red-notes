import { FilesController } from '@/Controllers/FilesController'
import { NoPreviewIllustration } from '@standardnotes/icons'
import { FileItem } from '@standardnotes/snjs'
import { useState } from 'react'
import Button from '../Button/Button'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'

type Props = {
  file: FileItem
  filesController: FilesController
  objectUrl: string
}

/**
 * In-app player for audio file attachments (audio/* mime types: mp3, ogg, wav,
 * m4a, webm, etc.). Renders an HTML5 <audio controls> element fed by the object
 * URL the viewer already created from the decrypted file bytes (cleanup of that
 * URL is handled by the parent PreviewComponent on unmount).
 *
 * Mirroring VideoPreview: some formats only play when the mime type is provided
 * via a <source type> tag (object URLs carry no extension), while others only
 * play with a bare src. We try <source type> first and fall back to src, then to
 * a download prompt if the browser can't decode the audio at all.
 */
const AudioPreview = ({ file, filesController, objectUrl }: Props) => {
  const [showError, setShowError] = useState(false)
  const [shouldTryFallback, setShouldTryFallback] = useState(false)

  if (showError) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <NoPreviewIllustration className="mb-4 h-30 w-30" />
        <div className="mb-2 text-base font-bold">This audio can't be played.</div>
        <div className="mb-4 max-w-[35ch] text-center text-sm text-passive-0">
          To listen to this file, download it and open it using another application.
        </div>
        <Button
          primary
          onClick={() => {
            filesController
              .handleFileAction({
                type: FileItemActionType.DownloadFile,
                payload: { file },
              })
              .catch(console.error)
          }}
        >
          Download
        </Button>
      </div>
    )
  }

  if (shouldTryFallback) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <audio
          className="w-full max-w-2xl"
          controls
          src={objectUrl}
          onError={() => {
            setShowError(true)
            setShouldTryFallback(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <audio
        className="w-full max-w-2xl"
        controls
        onError={() => {
          setShouldTryFallback(true)
        }}
      >
        <source src={objectUrl} type={file.mimeType} />
      </audio>
    </div>
  )
}

export default AudioPreview
