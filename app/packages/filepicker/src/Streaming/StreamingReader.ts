import { ByteChunker, OnChunkCallbackNoProgress } from '@standardnotes/files'
import { FileReaderInterface } from './../Interface/FileReader'
import { FileSelectionResponse } from '../types'

interface StreamingFileReaderInterface {
  getFilesFromHandles(handles: FileSystemFileHandle[]): Promise<File[]>
}

/**
 * The File System Access API File Picker
 * https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
 */
export const StreamingFileReader: StreamingFileReaderInterface & FileReaderInterface = {
  getFilesFromHandles,
  selectFiles,
  readFile,
  available,
  maximumFileSize,
}

function maximumFileSize(): number | undefined {
  return undefined
}

function getFilesFromHandles(handles: FileSystemFileHandle[]): Promise<File[]> {
  return Promise.all(handles.map((handle) => handle.getFile()))
}

async function selectFiles(): Promise<File[]> {
  let selectedFilesHandles: FileSystemFileHandle[]
  try {
    selectedFilesHandles = await window.showOpenFilePicker!({ multiple: true })
  } catch {
    selectedFilesHandles = []
  }
  return getFilesFromHandles(selectedFilesHandles)
}

async function readFile(
  file: File,
  minimumChunkSize: number,
  onChunk: OnChunkCallbackNoProgress,
): Promise<FileSelectionResponse> {
  const byteChunker = new ByteChunker(minimumChunkSize, onChunk)
  const stream = file.stream() as unknown as ReadableStream
  const reader = stream.getReader()

  let previousChunk: Uint8Array | undefined

  try {
    for (;;) {
      const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>
      if (result.done) {
        await byteChunker.addBytes(previousChunk ?? new Uint8Array(), true)
        break
      }

      if (previousChunk !== undefined) {
        await byteChunker.addBytes(previousChunk, false)
      }

      previousChunk = result.value
    }

    return {
      name: file.name,
      mimeType: file.type,
    }
  } catch (error) {
    try {
      await reader.cancel(error)
    } catch {
      // Preserve the original read/consumer error.
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}

function available(): boolean {
  return window.showOpenFilePicker != undefined
}
