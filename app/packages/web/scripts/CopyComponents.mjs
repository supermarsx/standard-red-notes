import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { doesDirExist, emptyExistingDir, ensureDirExists, copyFileOrDir } from '../../../scripts/ScriptUtils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const components = {
  '@standardnotes/authenticator': 'org.standardnotes.token-vault',
  '@standardnotes/bold-editor': 'org.standardnotes.bold-editor',
  '@standardnotes/classic-code-editor': 'org.standardnotes.code-editor',
  '@standardnotes/markdown-basic': 'org.standardnotes.simple-markdown-editor',
  '@standardnotes/markdown-hybrid': 'org.standardnotes.advanced-markdown-editor',
  '@standardnotes/markdown-math': 'org.standardnotes.fancy-markdown-editor',
  '@standardnotes/markdown-minimal': 'org.standardnotes.minimal-markdown-editor',
  '@standardnotes/markdown-visual': 'org.standardnotes.markdown-visual-editor',
  '@standardnotes/rich-text': 'org.standardnotes.plus-editor',
  '@standardnotes/simple-task-editor': 'org.standardnotes.simple-task-editor',
  '@standardnotes/spreadsheets': 'org.standardnotes.standard-sheets',
}

const BasePath = path.join(__dirname, '../../../node_modules')

const FilesToCopy = ['index.html', 'dist', 'build', 'package.json']

const copyComponentAssets = async (srcComponentPath, destination, exludedFilesGlob) => {
  if (!doesDirExist(srcComponentPath)) {
    return false
  }

  emptyExistingDir(destination)
  ensureDirExists(destination)

  for (const file of FilesToCopy) {
    const srcFilePath = path.join(srcComponentPath, file)
    if (!fs.existsSync(srcFilePath)) {
      continue
    }

    const targetFilePath = path.join(destination, file)
    copyFileOrDir(srcFilePath, targetFilePath, exludedFilesGlob)
  }

  return true
}

for (const packageName of Object.keys(components)) {
  const identifier = components[packageName]
  const packagePath = `${BasePath}/${packageName}`

  const assetsPath = `src/components/assets/${identifier}`
  fs.mkdirSync(assetsPath, { recursive: true })

  await copyComponentAssets(packagePath, assetsPath, '**/package.json')
}

// Standard Red Notes: re-apply the region-aware date patch to the freshly-extracted
// standard-sheets (Kendo) spreadsheet. copyComponentAssets empties the dir on every build,
// so the locale snippet + Kendo culture files (kept tracked under scripts/standard-sheets-patch,
// which is never wiped) must be injected HERE, after extraction, to survive each build.
const patchStandardSheets = () => {
  const sheetsDist = 'src/components/assets/org.standardnotes.standard-sheets/dist'
  const indexPath = path.join(sheetsDist, 'index.html')
  const patchDir = path.join(__dirname, 'standard-sheets-patch')
  if (!fs.existsSync(indexPath) || !fs.existsSync(patchDir)) {
    return
  }

  let html = fs.readFileSync(indexPath, 'utf8')
  if (!html.includes('__snSheetsCulture')) {
    const snippet = fs.readFileSync(path.join(patchDir, 'locale-snippet.html'), 'utf8')
    const marker = '<script src="./vendor/js/kendo.spreadsheet.min.js"></script>'
    if (html.includes(marker)) {
      fs.writeFileSync(indexPath, html.replace(marker, `${marker}\n${snippet}`))
    }
  }

  const culturesSrc = path.join(patchDir, 'cultures')
  if (fs.existsSync(culturesSrc)) {
    const culturesDest = path.join(sheetsDist, 'vendor/js/cultures')
    ensureDirExists(culturesDest)
    for (const file of fs.readdirSync(culturesSrc)) {
      fs.copyFileSync(path.join(culturesSrc, file), path.join(culturesDest, file))
    }
  }
}

patchStandardSheets()
