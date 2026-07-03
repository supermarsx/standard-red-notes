import { ChunkId } from '../Upload/ChunkId'
import { UploadChunkResult } from '../Upload/UploadChunkResult'
import { UploadId } from '../Upload/UploadId'

export interface FileUploaderInterface {
  createUploadSession(filePath: string): Promise<UploadId>
  uploadFileChunk(dto: {
    uploadId: string
    data: Uint8Array
    filePath: string
    chunkId: ChunkId
    unencryptedFileSize: number
  }): Promise<string>
  finishUploadSession(uploadId: string, filePath: string, uploadChunkResults: Array<UploadChunkResult>): Promise<void>
  // Aborts an in-progress upload session, discarding any already-uploaded parts.
  // For S3 this issues an AbortMultipartUpload so orphaned parts are not billed;
  // for FS it discards the buffered chunks. Best-effort cleanup path invoked when
  // a session is rejected (cap/quota) or otherwise cannot be completed.
  abortUploadSession(uploadId: string, filePath: string): Promise<void>
}
