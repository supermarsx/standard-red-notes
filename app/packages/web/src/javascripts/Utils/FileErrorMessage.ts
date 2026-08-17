const MAX_FILE_ERROR_DETAIL_LENGTH = 300

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error) {
    return error.message
  }
  if (error && typeof error === 'object' && typeof (error as { text?: unknown }).text === 'string') {
    return (error as { text: string }).text
  }
  return undefined
}

export function sanitizeFileErrorDetail(error: unknown): string | undefined {
  const rawDetail = errorText(error)
  if (!rawDetail) {
    return undefined
  }

  let printableDetail = ''
  for (const character of rawDetail) {
    const code = character.charCodeAt(0)
    printableDetail += code <= 0x1f || code === 0x7f ? ' ' : character
    if (printableDetail.length >= MAX_FILE_ERROR_DETAIL_LENGTH) {
      break
    }
  }

  const detail = printableDetail.replace(/\s+/g, ' ').trim()
  return detail || undefined
}

export function formatFileDownloadError(error: unknown): string {
  const detail = sanitizeFileErrorDetail(error)
  return detail ? `Unable to download the file: ${detail}` : 'There was an error while downloading the file.'
}
