import { BlockWithAlignableContents } from '@lexical/react/LexicalBlockWithAlignableContents'
import { Platform, classNames } from '@standardnotes/snjs'
import { $getNodeByKey, CLICK_COMMAND, COMMAND_PRIORITY_LOW, ElementFormatType, NodeKey } from 'lexical'
import { InlineFileNode } from './InlineFileNode'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import { useApplication } from '@/Components/ApplicationProvider'
import { useCallback, useEffect, useRef, useState } from 'react'
import { $createFileNode } from '../EncryptedFilePlugin/Nodes/FileUtils'
import { isIOS } from '@standardnotes/ui-services'
import Icon from '@/Components/Icon/Icon'
import Spinner from '@/Components/Spinner/Spinner'
import SuperEmbeddedImage from '../ImageTools/SuperEmbeddedImage'
import { ImageFloat } from '../ImageTools/ImageToolsTypes'

type Props = {
  fileName: string | undefined
  mimeType: string
  src: string
  className: Readonly<{
    base: string
    focus: string
  }>
  format: ElementFormatType | null
  setFormat: (format: ElementFormatType) => void
  node: InlineFileNode
  nodeKey: NodeKey
  width: number | undefined
  setWidth: (width: number | undefined) => void
  caption: string | undefined
  setCaption: (caption: string | undefined) => void
  float: ImageFloat
  setFloat: (float: ImageFloat) => void
}

const InlineFileComponent = ({
  className,
  src,
  mimeType,
  fileName,
  format,
  setFormat,
  node,
  nodeKey,
  width,
  setWidth,
  caption,
  setCaption,
  float,
  setFloat,
}: Props) => {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()
  const imageWrapperRef = useRef<HTMLDivElement>(null)
  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        if (imageWrapperRef.current?.contains(event.target as Node)) {
          event.preventDefault()
          $getNodeByKey(nodeKey)?.selectEnd()
          setTimeout(() => {
            setSelected(!isSelected)
          })
          return true
        }
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, isSelected, nodeKey, setSelected])

  const [isSaving, setIsSaving] = useState(false)
  const saveToFilesAndReplaceNode = useCallback(async () => {
    setIsSaving(true)
    try {
      const blob = await fetch(src).then((response) => response.blob())
      const file = new File([blob], fileName || application.generateUUID(), { type: mimeType })

      const { filesController, linkingController } = application

      const uploadedFile = await filesController.uploadNewFile(file, { showToast: false })

      if (!uploadedFile) {
        return
      }

      editor.update(() => {
        const fileNode = $createFileNode(uploadedFile.uuid)
        node.replace(fileNode)
      })

      void linkingController.linkItemToSelectedItem(uploadedFile)
    } catch (error) {
      console.error(error)
    } finally {
      setIsSaving(false)
    }
  }, [application, editor, fileName, mimeType, node, src])

  const isPDF = mimeType === 'application/pdf'

  const changeAlignment = useCallback(
    (format: ElementFormatType) => {
      editor.update(() => {
        setFormat(format)
      })
    },
    [editor, setFormat],
  )
  const changeWidth = useCallback(
    (newWidth: number | undefined) => editor.update(() => setWidth(newWidth)),
    [editor, setWidth],
  )
  const changeCaption = useCallback(
    (newCaption: string | undefined) => editor.update(() => setCaption(newCaption)),
    [editor, setCaption],
  )
  const changeFloat = useCallback(
    (newFloat: ImageFloat) => editor.update(() => setFloat(newFloat)),
    [editor, setFloat],
  )

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      {mimeType.startsWith('image') ? (
        <div
          ref={imageWrapperRef}
          className="group relative flex min-h-[2rem] flex-col gap-2.5"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <SuperEmbeddedImage
            src={src}
            alt={fileName}
            alignment={format ?? ''}
            onAlignmentChange={changeAlignment}
            width={width}
            onWidthChange={changeWidth}
            caption={caption}
            onCaptionChange={changeCaption}
            float={float}
            onFloatChange={changeFloat}
            isSelected={isSelected}
          />
        </div>
      ) : mimeType.startsWith('video') ? (
        <video className="h-full w-full" controls autoPlay>
          <source src={src} type={mimeType} />
        </video>
      ) : mimeType.startsWith('audio') ? (
        <div className="flex h-full w-full items-center justify-center">
          <audio controls>
            <source src={src} type={mimeType} />
          </audio>
        </div>
      ) : (
        <object
          className={classNames('h-full w-full', isPDF && 'min-h-[65vh]')}
          data={isPDF ? src + '#view=FitV' : src}
        />
      )}
      <button
        className={classNames(
          'mx-auto mt-2 flex items-center gap-2.5 rounded border border-border bg-default px-2.5 py-1.5',
          !isSaving && 'hover:bg-info hover:text-info-contrast',
        )}
        onClick={() => {
          const isIOSPlatform = application.platform === Platform.Ios || isIOS()
          if (isIOSPlatform && document.activeElement) {
            ;(document.activeElement as HTMLElement).blur()
          }
          saveToFilesAndReplaceNode().catch(console.error)
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Spinner className="h-4 w-4" />
            Saving...
          </>
        ) : (
          <>
            <Icon type="download" />
            Save to Files
          </>
        )}
      </button>
    </BlockWithAlignableContents>
  )
}

export default InlineFileComponent
