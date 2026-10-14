import type { AccountStorageUsage, AccountStorageComponent } from '@standardnotes/snjs'

export function storageBytes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 'Not reported'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}`
}

export function presentStorageUsage(usage: AccountStorageUsage) {
  const parts: Array<{ key: 'items' | 'files' | 'revisions'; label: string; value?: AccountStorageComponent }> = [
    {
      key: 'items',
      label: 'Encrypted items',
      value: usage.components?.items ?? {
        bytes: usage.itemBytesUsed,
        count: usage.itemsMeasured,
        complete: usage.itemsUnmeasured === 0,
      },
    },
    { key: 'files', label: 'Uploaded files', value: usage.components?.files },
    { key: 'revisions', label: 'Saved revisions', value: usage.components?.revisions },
  ]
  const measured = parts.every(
    (part) =>
      part.value?.complete === true &&
      typeof part.value.bytes === 'number' &&
      Number.isSafeInteger(part.value.bytes) &&
      part.value.bytes >= 0,
  )
  const sum = parts.reduce((total, part) => total + (part.value?.bytes ?? 0), 0)
  const complete = measured && usage.complete === true && usage.totalBytesUsed === sum && Number.isSafeInteger(sum)
  return {
    complete,
    total: complete ? storageBytes(usage.totalBytesUsed) : 'Unavailable',
    parts: parts.map((part) => ({
      key: part.key,
      label: part.label,
      text: part.value?.complete === true ? storageBytes(part.value.bytes) : 'Not fully measured',
      count:
        typeof part.value?.count === 'number' && Number.isSafeInteger(part.value.count) && part.value.count >= 0
          ? part.value.count
          : undefined,
    })),
  }
}
