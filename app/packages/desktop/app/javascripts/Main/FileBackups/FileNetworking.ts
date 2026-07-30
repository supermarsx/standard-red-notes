import axios, { RawAxiosResponseHeaders } from 'axios'

const FileBackupDownloadTimeout = 120_000

export async function downloadData(
  url: string,
  headers: RawAxiosResponseHeaders,
  maximumResponseBytes: number,
): Promise<{
  data: Uint8Array
  headers: RawAxiosResponseHeaders
  status: number
}> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: headers,
    maxContentLength: maximumResponseBytes,
    maxBodyLength: maximumResponseBytes,
    timeout: FileBackupDownloadTimeout,
  })

  return {
    data: Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data),
    headers: response.headers,
    status: response.status,
  }
}
