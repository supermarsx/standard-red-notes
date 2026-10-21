import { SNApplication, FileItem, ClientDisplayableError } from '../../../snjs'
import { ClassicFileReader, ClassicFileSaver } from '../../../filepicker'

export class ClassicFileApi {
  constructor(private application: SNApplication) {
    this.configureFilePicker()
  }

  configureFilePicker(): void {
    const input = document.getElementById('filePicker') as HTMLInputElement
    input.onclick = () => {
      void this.openFilePicker()
    }
    console.log('Classic file picker ready.')
  }

  async openFilePicker(): Promise<void> {
    const files = await ClassicFileReader.selectFiles()
    for (const file of files) {
      const operation = await this.application.files.beginNewFileUpload(file.size)
      if (operation instanceof ClientDisplayableError) {
        continue
      }
      const fileResult = await ClassicFileReader.readFile(file, 2_000_000, async ({ data, index, isLast }) => {
        const failure = await this.application.files.pushBytesForUpload(operation, data, index, isLast)
        if (failure) {
          throw new Error(failure.text)
        }
      })
      const snFile = await this.application.files.finishUpload(operation, fileResult, crypto.randomUUID())

      if (snFile instanceof ClientDisplayableError) {
        return
      }

      const bytes = await this.downloadFileBytes(snFile)

      new ClassicFileSaver().saveFile(snFile.name, bytes)
    }
  }

  downloadFileBytes = async (file: FileItem): Promise<Uint8Array> => {
    console.log('Downloading file')

    let receivedBytes = new Uint8Array()

    const failure = await this.application.files.downloadFile(file, async (decryptedBytes: Uint8Array) => {
      console.log(`Downloaded ${decryptedBytes.length} bytes`)
      receivedBytes = new Uint8Array([...receivedBytes, ...decryptedBytes])
    })
    if (failure) {
      throw new Error(failure.text)
    }

    console.log('Successfully downloaded and decrypted file!')

    return receivedBytes
  }
}
