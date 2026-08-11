import { createHeadlessEditor } from '@lexical/headless'
import { FileItem, PrefKey, PrefValue, SuperConverterServiceInterface } from '@standardnotes/snjs'
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  LexicalEditor,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical'
import BlocksEditorTheme from '../Lexical/Theme/Theme'
import { BlockEditorNodes, SuperExportNodes } from '../Lexical/Nodes/AllNodes'
import { MarkdownTransformers } from '../MarkdownTransformers'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $createFileExportNode } from '../Lexical/Nodes/FileExportNode'
import { $createInlineFileNode } from '../Plugins/InlineFilePlugin/InlineFileNode'
import { $convertFromMarkdownString } from '@lexical/markdown'
import { $convertToMarkdownString } from '../Lexical/Utils/MarkdownExport'
import { parseFileName } from '@standardnotes/utils'
import { $dfs } from '@lexical/utils'
import { $isFileNode } from '../Plugins/EncryptedFilePlugin/Nodes/FileUtils'
import { $generateNodesFromSerializedNodes, $insertGeneratedNodes } from '@lexical/clipboard'
import type { PageLayoutOptions } from '../Lexical/Utils/DocExport/PageLayoutOptions'
import { $projectChecklistDueDatesForPortableExport } from '../Checklist/ChecklistPortableExport'

type SuperConversionConfig = {
  embedBehavior?: PrefValue[PrefKey.SuperNoteExportEmbedBehavior]
  getFileItem?: (id: string) => FileItem | undefined
  getFileBase64?: (id: string) => Promise<string | undefined>
  pdf?: {
    pageSize?: PrefValue[PrefKey.SuperNoteExportPDFPageSize]
    /** Standard Red Notes: per-note page numbering / header / footer (from NoteLayout). */
    pageLayout?: PageLayoutOptions
  }
  /** One stable clock snapshot for every deadline projected by this export. */
  now?: number
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read generated PDF'))
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Could not read generated PDF'))
      }
    }
    reader.readAsDataURL(blob)
  })

export class HeadlessSuperConverter implements SuperConverterServiceInterface {
  private importEditor: LexicalEditor
  private exportEditor: LexicalEditor

  constructor() {
    this.importEditor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (error: Error) => console.error(error),
      nodes: BlockEditorNodes,
    })
    this.exportEditor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (error: Error) => console.error(error),
      nodes: SuperExportNodes,
    })
  }

  isValidSuperString(superString: string): boolean {
    try {
      this.importEditor.parseEditorState(superString)
      return true
    } catch {
      return false
    }
  }

  /** Load the latest note state and replace embedded file nodes for an export. */
  private async prepareExportEditor(
    superString: string,
    toFormat: 'txt' | 'md' | 'html' | 'json' | 'pdf',
    config?: SuperConversionConfig,
  ): Promise<void> {
    const { embedBehavior, getFileItem, getFileBase64 } = config ?? { embedBehavior: 'reference' }

    if (embedBehavior === 'separate' && !getFileItem) {
      throw new Error('getFileItem must be provided when embedBehavior is "separate"')
    }
    if (embedBehavior === 'inline' && !getFileItem && !getFileBase64) {
      throw new Error('getFileItem and getFileBase64 must be provided when embedBehavior is "inline"')
    }

    if (superString.length === 0) {
      // The converter is a singleton. Explicitly clear prior content so an empty
      // note produces a genuinely blank document rather than the last export.
      this.exportEditor.update(() => $getRoot().clear(), { discrete: true })
    } else {
      this.exportEditor.setEditorState(this.exportEditor.parseEditorState(superString))
    }

    await new Promise<void>((resolve, reject) => {
      const handleFileNodes = () => {
        if (embedBehavior === 'reference' || !getFileItem) {
          resolve()
          return
        }
        const filenameCounts: Record<string, number> = {}
        Promise.all(
          $dfs().map(async ({ node: fileNode }) => {
            if (!$isFileNode(fileNode)) {
              return
            }
            const fileItem = getFileItem(fileNode.getId())
            if (!fileItem) {
              return
            }
            const canInlineFileType = toFormat === 'pdf' ? fileItem.mimeType.startsWith('image/') : true
            if (embedBehavior === 'inline' && getFileBase64 && canInlineFileType) {
              const fileBase64 = await getFileBase64(fileNode.getId())
              if (!fileBase64) {
                return
              }
              this.exportEditor.update(
                () => {
                  const inlineFileNode = $createInlineFileNode(fileBase64, fileItem.mimeType, fileItem.name)
                  fileNode.replace(inlineFileNode)
                },
                { discrete: true },
              )
            } else {
              this.exportEditor.update(
                () => {
                  filenameCounts[fileItem.name] =
                    filenameCounts[fileItem.name] == undefined ? 0 : filenameCounts[fileItem.name] + 1

                  let name = fileItem.name
                  if (filenameCounts[name] > 0) {
                    const { name: baseName, ext } = parseFileName(name)
                    name = `${baseName}-${fileItem.uuid}.${ext}`
                  }

                  fileNode.replace($createFileExportNode(name, fileItem.mimeType))
                },
                { discrete: true },
              )
            }
          }),
        )
          .then(() => resolve())
          .catch(reject)
      }
      this.exportEditor.update(handleFileNodes, { discrete: true })
    })
  }

  /** Generate a valid PDF Blob without an object-URL/fetch round trip. */
  async convertSuperStringToPDFBlob(superString: string, config?: SuperConversionConfig): Promise<Blob> {
    await this.prepareExportEditor(superString, 'pdf', config)
    const { $generatePDFFromNodes } = await import('../Lexical/Utils/PDFExport/PDFExport')
    return $generatePDFFromNodes(
      this.exportEditor,
      config?.pdf?.pageSize || 'A4',
      config?.pdf?.pageLayout,
      config?.now ?? Date.now(),
    )
  }

  async convertSuperStringToOtherFormat(
    superString: string,
    toFormat: 'txt' | 'md' | 'html' | 'json' | 'pdf',
    config?: SuperConversionConfig,
  ): Promise<string> {
    if (superString.length === 0 && toFormat !== 'pdf') {
      return superString
    }

    // Keep the legacy string contract for interface consumers, but never create
    // an object URL. The actual note-download path calls the Blob method below.
    if (toFormat === 'pdf') {
      return blobToDataUrl(await this.convertSuperStringToPDFBlob(superString, config))
    }

    await this.prepareExportEditor(superString, toFormat, config)
    const exportNow = config?.now ?? Date.now()

    let content: string | undefined

    await new Promise<void>((resolve) => {
      const convertToFormat = () => {
        if (toFormat === 'txt' || toFormat === 'md' || toFormat === 'html') {
          $projectChecklistDueDatesForPortableExport(exportNow)
        }
        switch (toFormat) {
          case 'txt': {
            // Plain text stripped of ALL formatting: just the document's text
            // content, no Markdown syntax, no HTML — newlines between blocks.
            content = $getRoot().getTextContent()
            resolve()
            break
          }
          case 'md': {
            content = $convertToMarkdownString(MarkdownTransformers)
            resolve()
            break
          }
          case 'html':
            content = $generateHtmlFromNodes(this.exportEditor)
            resolve()
            break
          case 'json':
          default:
            content = superString
            resolve()
            break
        }
      }
      this.exportEditor.update(convertToFormat, { discrete: true })
    })

    if (typeof content !== 'string') {
      throw new Error('Could not export note')
    }

    return content
  }

  convertOtherFormatToSuperString: SuperConverterServiceInterface['convertOtherFormatToSuperString'] = (
    otherFormatString,
    fromFormat,
    options,
  ) => {
    if (otherFormatString.length === 0) {
      return otherFormatString
    }

    if (fromFormat === 'json' && this.isValidSuperString(otherFormatString)) {
      return otherFormatString
    }

    this.importEditor.update(
      () => {
        $getRoot().clear()
      },
      {
        discrete: true,
      },
    )

    let didThrow = false
    if (fromFormat === 'html') {
      const htmlOptions = options?.html || {
        addLineBreaks: true,
      }

      this.importEditor.update(
        () => {
          try {
            const parser = new DOMParser()
            const dom = parser.parseFromString(otherFormatString, 'text/html')
            const generatedNodes = $generateNodesFromDOM(this.importEditor, dom)
            const nodesToInsert: LexicalNode[] = []
            generatedNodes.forEach((node) => {
              const type = node.getType()

              // Wrap text & link nodes with paragraph since they can't
              // be top-level nodes in Super
              if (
                type === 'text' ||
                type === 'link' ||
                type === 'linebreak' ||
                type === 'unencrypted-image' ||
                type === 'inline-file' ||
                type === 'snfile'
              ) {
                const paragraphNode = $createParagraphNode()
                paragraphNode.append(node)
                nodesToInsert.push(paragraphNode)
                return
              } else {
                nodesToInsert.push(node)
              }

              if (htmlOptions.addLineBreaks) {
                nodesToInsert.push($createParagraphNode())
              }
            })
            $getRoot().selectEnd()
            $insertNodes(nodesToInsert.concat($createParagraphNode()))
          } catch (error) {
            console.error(error)
            didThrow = true
          }
        },
        { discrete: true },
      )
    } else {
      this.importEditor.update(
        () => {
          try {
            $convertFromMarkdownString(otherFormatString, MarkdownTransformers, undefined, true)
          } catch (error) {
            console.error(error)
            didThrow = true
          }
        },
        {
          discrete: true,
        },
      )
    }

    if (didThrow) {
      throw new Error('Could not import note. Check error console for details.')
    }

    return JSON.stringify(this.importEditor.getEditorState())
  }

  getEmbeddedFileIDsFromSuperString(superString: string): string[] {
    if (superString.length === 0) {
      return []
    }

    this.exportEditor.setEditorState(this.exportEditor.parseEditorState(superString))

    const ids: string[] = []

    this.exportEditor.getEditorState().read(() => {
      for (const { node: fileNode } of $dfs()) {
        if (!$isFileNode(fileNode)) {
          continue
        }
        const nodeId = fileNode.getId()
        if (ids.includes(nodeId)) {
          continue
        }
        ids.push(nodeId)
      }
    })

    return ids
  }

  /**
   * Serialized nodes (usually generated by `$generateJSONFromSelectedNodes`) cannot be imported into
   * Lexical if they were directly stringified. This function handles the process of generating actual
   * Lexical nodes from the serialized ones, inserting them into an empty editor and then exporting the
   * editor state of that as a JSON, which can then be used to create a new note.
   */
  getStringifiedJSONFromSerializedNodes(serializedNodes: SerializedLexicalNode[]) {
    this.exportEditor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const selection = root.selectEnd()
        const generatedNodes = $generateNodesFromSerializedNodes(serializedNodes)
        $insertGeneratedNodes(this.exportEditor, generatedNodes, selection)
      },
      {
        discrete: true,
      },
    )
    return this.exportEditor.read(() => {
      return JSON.stringify(this.exportEditor.getEditorState().toJSON())
    })
  }
}
