// @ts-nocheck
/**
 * Standard Red Notes: self-hosting fetcher for the editor's bundled web fonts.
 *
 * All catalog fonts are open-source (Google Fonts, OFL/Apache). This script is
 * the reproducible record of HOW the ./files/*.woff2 binaries were obtained: for
 * each {family, weight} it asks the Google Fonts css2 API (with a modern UA so
 * woff2 is served), pulls the LATIN-subset woff2 URL, downloads it to
 * ./files/<base>-<weight>.woff2, and verifies the wOF2 magic. It is idempotent —
 * a present, valid file is skipped — so re-running only fetches what's missing.
 *
 * Usage:
 *   node fetch-fonts.mjs [--category=Sans-serif|Serif|Monospace|Handwriting]
 *   node fetch-fonts.mjs --emit-css       # print @font-face blocks for files that exist
 *   node fetch-fonts.mjs --emit-catalog   # print FONT_CATALOG entries for files that exist
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES_DIR = join(HERE, 'files')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * The NEW fonts added in this batch. `family` is the Google Fonts name, `css` is
 * the catalog font-family value, `base` is the woff2 filename stem, `weights`
 * are the CSS weights to fetch (only those Google actually ships are kept).
 */
const MANIFEST = [
  // ---- Sans-serif --------------------------------------------------------
  { name: 'Roboto', family: 'Roboto', css: "'Roboto', sans-serif", category: 'Sans-serif', base: 'roboto', weights: [400, 500, 700] },
  { name: 'Open Sans', family: 'Open Sans', css: "'Open Sans', sans-serif", category: 'Sans-serif', base: 'open-sans', weights: [400, 600, 700] },
  { name: 'Lato', family: 'Lato', css: "'Lato', sans-serif", category: 'Sans-serif', base: 'lato', weights: [400, 700] },
  { name: 'Montserrat', family: 'Montserrat', css: "'Montserrat', sans-serif", category: 'Sans-serif', base: 'montserrat', weights: [400, 500, 700] },
  { name: 'Poppins', family: 'Poppins', css: "'Poppins', sans-serif", category: 'Sans-serif', base: 'poppins', weights: [400, 500, 600] },
  { name: 'Nunito', family: 'Nunito', css: "'Nunito', sans-serif", category: 'Sans-serif', base: 'nunito', weights: [400, 600, 700] },
  { name: 'Work Sans', family: 'Work Sans', css: "'Work Sans', sans-serif", category: 'Sans-serif', base: 'work-sans', weights: [400, 500, 700] },
  { name: 'Source Sans 3', family: 'Source Sans 3', css: "'Source Sans 3', sans-serif", category: 'Sans-serif', base: 'source-sans-3', weights: [400, 600, 700] },
  { name: 'Raleway', family: 'Raleway', css: "'Raleway', sans-serif", category: 'Sans-serif', base: 'raleway', weights: [400, 500, 700] },
  { name: 'DM Sans', family: 'DM Sans', css: "'DM Sans', sans-serif", category: 'Sans-serif', base: 'dm-sans', weights: [400, 500, 700] },

  // ---- Serif -------------------------------------------------------------
  { name: 'Merriweather', family: 'Merriweather', css: "'Merriweather', serif", category: 'Serif', base: 'merriweather', weights: [400, 700] },
  { name: 'Playfair Display', family: 'Playfair Display', css: "'Playfair Display', serif", category: 'Serif', base: 'playfair-display', weights: [400, 500, 700] },
  { name: 'Lora', family: 'Lora', css: "'Lora', serif", category: 'Serif', base: 'lora', weights: [400, 500, 700] },
  { name: 'PT Serif', family: 'PT Serif', css: "'PT Serif', serif", category: 'Serif', base: 'pt-serif', weights: [400, 700] },
  { name: 'Source Serif 4', family: 'Source Serif 4', css: "'Source Serif 4', serif", category: 'Serif', base: 'source-serif-4', weights: [400, 600, 700] },
  { name: 'Bitter', family: 'Bitter', css: "'Bitter', serif", category: 'Serif', base: 'bitter', weights: [400, 500, 700] },
  { name: 'Crimson Text', family: 'Crimson Text', css: "'Crimson Text', serif", category: 'Serif', base: 'crimson-text', weights: [400, 600, 700] },
  { name: 'Libre Baskerville', family: 'Libre Baskerville', css: "'Libre Baskerville', serif", category: 'Serif', base: 'libre-baskerville', weights: [400, 700] },
  { name: 'EB Garamond', family: 'EB Garamond', css: "'EB Garamond', serif", category: 'Serif', base: 'eb-garamond', weights: [400, 500, 600] },
  { name: 'Cormorant Garamond', family: 'Cormorant Garamond', css: "'Cormorant Garamond', serif", category: 'Serif', base: 'cormorant-garamond', weights: [400, 500, 700] },

  // ---- Monospace ---------------------------------------------------------
  { name: 'Roboto Mono', family: 'Roboto Mono', css: "'Roboto Mono', monospace", category: 'Monospace', base: 'roboto-mono', weights: [400, 500, 700] },
  { name: 'Fira Code', family: 'Fira Code', css: "'Fira Code', monospace", category: 'Monospace', base: 'fira-code', weights: [400, 500, 700] },
  { name: 'IBM Plex Mono', family: 'IBM Plex Mono', css: "'IBM Plex Mono', monospace", category: 'Monospace', base: 'ibm-plex-mono', weights: [400, 500, 700] },
  { name: 'Space Mono', family: 'Space Mono', css: "'Space Mono', monospace", category: 'Monospace', base: 'space-mono', weights: [400, 700] },
  { name: 'Ubuntu Mono', family: 'Ubuntu Mono', css: "'Ubuntu Mono', monospace", category: 'Monospace', base: 'ubuntu-mono', weights: [400, 700] },
  { name: 'Anonymous Pro', family: 'Anonymous Pro', css: "'Anonymous Pro', monospace", category: 'Monospace', base: 'anonymous-pro', weights: [400, 700] },
  { name: 'Cousine', family: 'Cousine', css: "'Cousine', monospace", category: 'Monospace', base: 'cousine', weights: [400, 700] },
  { name: 'Overpass Mono', family: 'Overpass Mono', css: "'Overpass Mono', monospace", category: 'Monospace', base: 'overpass-mono', weights: [400, 600, 700] },
  { name: 'Red Hat Mono', family: 'Red Hat Mono', css: "'Red Hat Mono', monospace", category: 'Monospace', base: 'red-hat-mono', weights: [400, 500, 700] },
  { name: 'DM Mono', family: 'DM Mono', css: "'DM Mono', monospace", category: 'Monospace', base: 'dm-mono', weights: [400, 500] },

  // ---- Handwriting -------------------------------------------------------
  { name: 'Dancing Script', family: 'Dancing Script', css: "'Dancing Script', cursive", category: 'Handwriting', base: 'dancing-script', weights: [400, 700] },
  { name: 'Kalam', family: 'Kalam', css: "'Kalam', cursive", category: 'Handwriting', base: 'kalam', weights: [400, 700] },
  { name: 'Shadows Into Light', family: 'Shadows Into Light', css: "'Shadows Into Light', cursive", category: 'Handwriting', base: 'shadows-into-light', weights: [400] },
]

const WEIGHT_NAMES = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
}

/** Extract the latin-subset woff2 URL from a Google css2 response. */
function latinWoff2Url(cssText) {
  // Google emits one block per subset, each preceded by a `/* subset */` comment.
  // Prefer the block commented `/* latin */`; fall back to one whose unicode-range
  // covers basic latin; finally the last woff2 in the document.
  const blocks = cssText.split('/*').map((b) => '/*' + b)
  const latin = blocks.find((b) => b.startsWith('/* latin */'))
  const pick = (b) => {
    const m = b && b.match(/url\((https:\/\/[^)]+\.woff2)\)/)
    return m ? m[1] : null
  }
  if (latin && pick(latin)) return pick(latin)
  const byRange = blocks.find((b) => /unicode-range:[^;]*U\+0000/.test(b) && pick(b))
  if (byRange) return pick(byRange)
  const all = cssText.match(/https:\/\/[^)]+\.woff2/g)
  return all ? all[all.length - 1] : null
}

async function fetchWeight(entry, weight) {
  const out = join(FILES_DIR, `${entry.base}-${weight}.woff2`)
  if (existsSync(out)) {
    const head = readFileSync(out).subarray(0, 4).toString('latin1')
    if (head === 'wOF2') return { weight, status: 'skip' }
  }
  const fam = entry.family.replace(/ /g, '+')
  const apiUrl = `https://fonts.googleapis.com/css2?family=${fam}:wght@${weight}&display=swap`
  const cssRes = await fetch(apiUrl, { headers: { 'User-Agent': UA } })
  if (!cssRes.ok) return { weight, status: 'unavailable', detail: `css2 ${cssRes.status}` }
  const cssText = await cssRes.text()
  const url = latinWoff2Url(cssText)
  if (!url) return { weight, status: 'unavailable', detail: 'no woff2 url' }
  const fontRes = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!fontRes.ok) return { weight, status: 'error', detail: `download ${fontRes.status}` }
  const buf = Buffer.from(await fontRes.arrayBuffer())
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') return { weight, status: 'error', detail: 'bad magic' }
  mkdirSync(FILES_DIR, { recursive: true })
  writeFileSync(out, buf)
  return { weight, status: 'ok', bytes: buf.length }
}

/** Which requested weights actually exist on disk as valid woff2 (for emit). */
function existingWeights(entry) {
  return entry.weights.filter((wt) => {
    const f = join(FILES_DIR, `${entry.base}-${wt}.woff2`)
    return existsSync(f) && readFileSync(f).subarray(0, 4).toString('latin1') === 'wOF2'
  })
}

function emitCss() {
  const order = ['Sans-serif', 'Serif', 'Monospace', 'Handwriting']
  const lines = []
  for (const cat of order) {
    const entries = MANIFEST.filter((e) => e.category === cat && existingWeights(e).length)
    if (!entries.length) continue
    lines.push(`\n/* ---- ${cat} (added) ${'-'.repeat(Math.max(0, 60 - cat.length))} */`)
    for (const e of entries) {
      const fam = e.css.match(/'([^']+)'/)[1]
      for (const wt of existingWeights(e)) {
        lines.push(
          `@font-face { font-family: '${fam}'; font-style: normal; font-weight: ${wt}; font-display: swap; src: url('./files/${e.base}-${wt}.woff2') format('woff2'); }`,
        )
      }
      lines.push('')
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
}

function emitCatalog() {
  const order = ['Sans-serif', 'Serif', 'Monospace', 'Handwriting']
  const lines = []
  for (const cat of order) {
    const entries = MANIFEST.filter((e) => e.category === cat && existingWeights(e).length)
    if (!entries.length) continue
    lines.push(`\n  // --- Added ${cat} ${'-'.repeat(Math.max(0, 56 - cat.length))}`)
    for (const e of entries) {
      const wts = existingWeights(e).join(', ')
      lines.push(`  { name: '${e.name}', css: "${e.css}", category: '${e.category}', weights: w(${wts}), bundled: true },`)
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
}

async function download() {
  const catArg = process.argv.find((a) => a.startsWith('--category='))
  const cat = catArg ? catArg.split('=')[1] : null
  const work = MANIFEST.filter((e) => !cat || e.category === cat)
  let ok = 0
  let skip = 0
  let bad = 0
  for (const entry of work) {
    const results = []
    for (const weight of entry.weights) {
      try {
        const r = await fetchWeight(entry, weight)
        results.push(r)
        if (r.status === 'ok') ok++
        else if (r.status === 'skip') skip++
        else bad++
      } catch (err) {
        results.push({ weight, status: 'error', detail: String(err.message || err) })
        bad++
      }
    }
    const summary = results.map((r) => `${r.weight}:${r.status}${r.detail ? `(${r.detail})` : ''}`).join(' ')
    console.log(`${entry.name.padEnd(20)} ${summary}`)
  }
  console.log(`\n[fetch-fonts] downloaded=${ok} skipped=${skip} failed=${bad}`)
  if (bad > 0) process.exitCode = 1
}

if (process.argv.includes('--emit-css')) emitCss()
else if (process.argv.includes('--emit-catalog')) emitCatalog()
else await download()
