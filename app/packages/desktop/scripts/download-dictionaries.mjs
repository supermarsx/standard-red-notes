#!/usr/bin/env node
/**
 * Downloads Hunspell `.bdic` spellcheck dictionaries and stores them under
 * `app/dictionaries/` so they can be BUNDLED with the desktop app instead of
 * being fetched at runtime from Standard Notes' host
 * (https://dictionaries.standardnotes.org/...). At runtime
 * `configureSpellCheckerDictionarySource` (app/javascripts/Main/Window.ts)
 * points Chromium's spellchecker at this bundled directory via a file:// URL.
 *
 * BUILD STEP (run before `yarn build`):
 *   yarn dictionaries:download
 *
 * Chromium loads dictionaries by requesting `<lang>-<hash>.bdic` from the
 * configured download URL. The filename hash MUST match what the bundled
 * Chromium (Electron) expects, so we mirror the SAME files Electron would
 * otherwise download from its default source. We therefore fetch from the
 * Chromium dictionary CDN (overridable with DICTIONARY_SOURCE_URL) and save the
 * files verbatim.
 *
 * Environment variables:
 *   DICTIONARY_SOURCE_URL  Base URL to fetch `.bdic` files from. Must end with
 *                          a trailing slash. Defaults to the Chromium CDN.
 *   DICTIONARY_LANGUAGES   Comma-separated list of language codes to fetch.
 *                          Defaults to a broad English + common-European set.
 *
 * NOTE: The `<hash>` suffix below is tied to a specific Chromium dictionary
 * revision. If you bump Electron and spellcheck stops working for a language,
 * refresh the hashes from the Chromium source of truth:
 *   https://source.chromium.org/chromium/chromium/src/+/main:third_party/hunspell_dictionaries/
 * (each `<lang>-N-N.bdic` file there is the canonical name + hash).
 */

import fs from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ScriptsDir = path.dirname(__filename)
const OutputDir = path.resolve(ScriptsDir, '..', 'app', 'dictionaries')

const DEFAULT_SOURCE_URL = 'https://redirector.gvt1.com/edgedl/chrome/dict/'

/**
 * Canonical Chromium `.bdic` filenames (language code + content hash). These
 * are the exact filenames Chromium/Electron requests, so bundling them under
 * these names lets the runtime file:// source satisfy requests offline.
 * Keep this list in sync with the Language enum in SpellcheckerManager.ts.
 */
const DEFAULT_DICTIONARIES = [
  'en-US-10-1.bdic',
  'en-GB-10-1.bdic',
  'en-CA-10-1.bdic',
  'en-AU-10-1.bdic',
  'es-ES-3-0.bdic',
  'fr-FR-3-0.bdic',
  'de-DE-3-0.bdic',
  'it-IT-3-0.bdic',
  'pt-BR-3-0.bdic',
  'pt-PT-3-0.bdic',
  'nl-NL-3-0.bdic',
  'pl-PL-3-0.bdic',
  'ru-RU-3-0.bdic',
  'sv-SE-3-0.bdic',
  'nb-NO-3-0.bdic',
  'da-DK-3-0.bdic',
  'cs-CZ-3-0.bdic',
  'el-GR-3-0.bdic',
  'tr-TR-4-0.bdic',
  'uk-UA-3-0.bdic',
  'ro-RO-3-0.bdic',
  'hr-HR-3-0.bdic',
  'hu-HU-3-0.bdic',
  'vi-VN-3-0.bdic',
  'fa-IR-8-0.bdic',
  'hy-3-0.bdic',
  'ko-3-0.bdic',
  'bg-BG-3-0.bdic',
  'lt-3-0.bdic',
  'lv-3-0.bdic',
  'et-3-0.bdic',
  'sh-3-0.bdic',
  'sq-3-0.bdic',
  'ta-IN-5-0.bdic',
  'hi-IN-3-0.bdic',
  'sr-3-0.bdic',
]

function baseUrl() {
  const url = process.env.DICTIONARY_SOURCE_URL || DEFAULT_SOURCE_URL
  return url.endsWith('/') ? url : `${url}/`
}

function dictionaryList() {
  const override = process.env.DICTIONARY_LANGUAGES
  if (!override) {
    return DEFAULT_DICTIONARIES
  }
  // Allow operators to pass either full `lang-hash.bdic` names or bare codes.
  return override
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.endsWith('.bdic') ? entry : `${entry}.bdic`))
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination)
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300) {
          file.close()
          fs.rmSync(destination, { force: true })
          reject(new Error(`HTTP ${response.statusCode} for ${url}`))
          return
        }
        response.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', (error) => {
        file.close()
        fs.rmSync(destination, { force: true })
        reject(error)
      })
  })
}

async function main() {
  fs.mkdirSync(OutputDir, { recursive: true })
  const source = baseUrl()
  const files = dictionaryList()

  console.log(`Downloading ${files.length} dictionaries from ${source}`)
  console.log(`Output: ${OutputDir}`)

  let succeeded = 0
  const failures = []

  for (const fileName of files) {
    const url = `${source}${fileName}`
    const destination = path.join(OutputDir, fileName)
    try {
      await download(url, destination)
      succeeded += 1
      console.log(`  ok   ${fileName}`)
    } catch (error) {
      failures.push({ fileName, message: error.message })
      console.warn(`  FAIL ${fileName}: ${error.message}`)
    }
  }

  console.log(`\nDone: ${succeeded}/${files.length} downloaded.`)
  if (failures.length > 0) {
    console.warn(
      'Some dictionaries failed. They may have a different content hash for ' +
        'your Chromium revision — refresh names from the Chromium hunspell ' +
        'dictionaries source listed at the top of this script.',
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
