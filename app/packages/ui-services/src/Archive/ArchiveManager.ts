import { parseFileName, createZippableFileName, sanitizeFileName } from '@standardnotes/utils'
import { createBackupFileName } from './BackupFileName'
import {
  BackupFile,
  BackupFileDecryptedContextualPayload,
  EncryptedItemInterface,
  NoteContent,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { ApplicationInterface } from '@standardnotes/services'

type ZippableData = {
  name: string
  content: Blob
}[]

type ObjectURL = string

export class ArchiveManager {
  private readonly application: ApplicationInterface
  private textFile?: string

  constructor(application: ApplicationInterface) {
    this.application = application
  }

  public async getMimeType(ext: string) {
    return (await import('@zip.js/zip.js')).getMimeType(ext)
  }

  public async downloadBackup(encrypted: boolean): Promise<void> {
    const result = encrypted
      ? await this.application.createEncryptedBackupFile.execute()
      : await this.application.createDecryptedBackupFile.execute()

    if (result.isFailed()) {
      return
    }

    const data = result.getValue()

    const blobData = new Blob([JSON.stringify(data, null, 2)], {
      type: 'text/json',
    })

    if (encrypted) {
      this.downloadData(
        blobData,
        `Standard Notes Encrypted Backup and Import File - ${this.formattedDateForExports()}.txt`,
      )
    } else {
      this.downloadZippedDecryptedItems(data).catch(console.error)
    }
  }

  formattedDateForExports() {
    const string = new Date().toString()
    // Match up to the first parenthesis, i.e do not include '(Central Standard Time)'
    const matches = string.match(/^(.*?) \(/)
    if (matches && matches.length >= 2) {
      return matches[1]
    }
    return string
  }

  async getZippedDecryptedItemsBlob(data: BackupFile) {
    const zip = await import('@zip.js/zip.js')
    const zipWriter = new zip.ZipWriter<Blob>(new zip.BlobWriter('application/zip'))
    const items = data.items

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'text/plain',
    })

    const fileName = createZippableFileName('Standard Notes Backup and Import File')
    await zipWriter.add(fileName, new zip.BlobReader(blob))

    // Track the FINAL (sanitized) zip entry paths we've used so two items that
    // sanitize to the same readable name never silently overwrite one another.
    const usedItemEntryPaths = new Set<string>()

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      let name, contents

      if (item.content_type === ContentType.TYPES.Note) {
        const note = item as BackupFileDecryptedContextualPayload<NoteContent>
        name = note.content.title
        contents = note.content.text
      } else {
        name = item.content_type
        contents = JSON.stringify(item.content, null, 2)
      }

      if (!name) {
        name = ''
      }

      const blob = new Blob([contents], { type: 'text/plain' })
      // Human-readable name (forum issue 4013): prefer the item title and append the
      // item's OWN created_at as `YYYY-MM-DDTHH.mm.ss` instead of the opaque uuid,
      // so a folder of backups is browsable. A short uuid suffix is added only when
      // needed so two items sharing a title (and second) never overwrite each other.
      const timestamp = item.created_at instanceof Date ? item.created_at : new Date(item.created_at)
      const baseEntryName = createBackupFileName(name, timestamp, 'txt')
      const { name: baseEntryStem, ext: baseEntryExt } = parseFileName(baseEntryName)
      const folder = `Items/${sanitizeFileName(item.content_type)}/`

      // The disambiguator (short uuid) is filesystem-safe, so build the collided name
      // by inserting it before the extension rather than re-sanitizing the stem (which
      // would turn the dots in the timestamp into underscores).
      const shortUuid = item.uuid.split('-')[0]
      let entryName = baseEntryName
      let counter = 0
      while (usedItemEntryPaths.has(folder + entryName)) {
        counter += 1
        const disambiguator = counter === 1 ? `-${shortUuid}` : `-${shortUuid}-${counter - 1}`
        entryName = `${baseEntryStem}${disambiguator}.${baseEntryExt}`
      }
      usedItemEntryPaths.add(folder + entryName)

      const fileName = folder + entryName
      await zipWriter.add(fileName, new zip.BlobReader(blob))
    }

    return await zipWriter.close()
  }

  private async downloadZippedDecryptedItems(data: BackupFile) {
    const zippedDecryptedItemsBlob = await this.getZippedDecryptedItemsBlob(data)
    this.downloadData(zippedDecryptedItemsBlob, `Standard Notes Backup - ${this.formattedDateForExports()}.zip`)
  }

  async zipData(data: ZippableData): Promise<Blob> {
    const zip = await import('@zip.js/zip.js')
    const writer = new zip.ZipWriter<Blob>(new zip.BlobWriter('application/zip'))

    // Dedup on the ACTUAL (sanitized + truncated) zip entry name, not the raw
    // input name — otherwise two notes whose names only differ past the 100-char
    // truncation, or after sanitization, collide and one is SILENTLY OVERWRITTEN
    // in the export (data loss in a backup).
    const usedNames = new Set<string>()

    for (let i = 0; i < data.length; i++) {
      const file = data[i]

      const { name, ext } = parseFileName(file.name)

      let entryName = createZippableFileName(name, '', ext)
      let counter = 1
      while (usedNames.has(entryName)) {
        entryName = createZippableFileName(name, ` - ${counter++}`, ext)
      }
      usedNames.add(entryName)

      await writer.add(entryName, new zip.BlobReader(file.content))
    }

    const zipFileAsBlob = await writer.close()

    return zipFileAsBlob
  }

  async downloadDataAsZip(data: ZippableData) {
    const zipFileAsBlob = await this.zipData(data)
    this.downloadData(zipFileAsBlob, `Standard Notes Export - ${this.formattedDateForExports()}.zip`)
  }

  private hrefForData(data: Blob) {
    // If we are replacing a previously generated file we need to
    // manually revoke the object URL to avoid memory leaks.
    if (this.textFile) {
      window.URL.revokeObjectURL(this.textFile)
    }
    this.textFile = window.URL.createObjectURL(data)
    // returns a URL you can use as a href
    return this.textFile
  }

  downloadData(data: Blob | ObjectURL, fileName: string): void {
    const link = document.createElement('a')
    link.setAttribute('download', fileName)
    link.href = typeof data === 'string' ? data : this.hrefForData(data)
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  downloadEncryptedItem(item: EncryptedItemInterface) {
    this.downloadData(new Blob([JSON.stringify(item.payload.ejected())]), `${item.uuid}.txt`)
  }

  downloadEncryptedItems(items: EncryptedItemInterface[]) {
    const data = JSON.stringify(items.map((i) => i.payload.ejected()))
    this.downloadData(new Blob([data]), 'errored-items.txt')
  }
}
