import { FileWithPath, filesWithPathsFromInput } from './DirectoryUpload'

/**
 * Standard Red Notes: open a native directory picker (`<input webkitdirectory>`)
 * and resolve to the selected files paired with their relative paths.
 *
 * We use a self-contained hidden input here (rather than the filepicker package's
 * `selectFiles`) because `webkitdirectory` is web-only and the File System Access
 * API has no broadly-available directory-of-files picker that yields relative
 * paths. The input is created on demand and removed after selection.
 */
export const selectDirectoryFiles = (): Promise<FileWithPath[]> => {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // Non-standard but widely supported attributes for whole-folder selection.
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.style.display = 'none'

    let settled = false
    const cleanup = () => {
      input.remove()
    }

    input.onchange = () => {
      settled = true
      const files = input.files ? filesWithPathsFromInput(input.files) : []
      cleanup()
      resolve(files)
    }

    // If the user cancels, `change` never fires; resolve empty on the next focus.
    const onFocusBack = () => {
      window.removeEventListener('focus', onFocusBack)
      // Give the change event a tick to fire first.
      setTimeout(() => {
        if (!settled) {
          cleanup()
          resolve([])
        }
      }, 300)
    }
    window.addEventListener('focus', onFocusBack)

    document.body.appendChild(input)
    input.click()
  })
}
