#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

export const FEATURE_SCREENSHOT_MANIFEST_PATH = 'docs/_data/feature_screenshots.json'
const README_CAPTURE_ID = 'workspace-overview'
const REQUIRED_CONTEXT_FILES = ['docs/onboarding.md', 'docs/client-platforms.md', 'docs/app-guide.md']
const FEATURE_INCLUDE_PATTERN = /{%\s*include\s+feature-screenshot\.html\b([\s\S]*?)%}/g
const ATTRIBUTE_PATTERN = /\b([a-z][a-z0-9_]*)\s*=\s*"([^"]*)"/g
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function displayPath(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function lineAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

function listDocumentationSources(directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '_site' || entry.name === 'assets') {
      continue
    }

    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listDocumentationSources(candidate))
    } else if (entry.isFile() && /\.(?:html|md)$/i.test(entry.name)) {
      files.push(candidate)
    }
  }

  return files.sort()
}

function numberValue(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseAttributes(source) {
  const attributes = {}
  const duplicates = []

  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    if (Object.hasOwn(attributes, match[1])) {
      duplicates.push(match[1])
    }
    attributes[match[1]] = match[2]
  }

  return { attributes, duplicates }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function captureContract(manifest, captureId) {
  const capture = manifest.captures?.[captureId]
  if (!capture) {
    throw new Error(`Screenshot manifest is missing capture "${captureId}"`)
  }
  return Object.freeze({
    captureId,
    assetPath: `docs/assets/${capture.asset}`,
    siteAssetPath: `/assets/${capture.asset}`,
    width: capture.width,
    height: capture.height,
  })
}

export function loadFeatureScreenshotManifest(root = repositoryRoot) {
  const manifestPath = path.join(root, FEATURE_SCREENSHOT_MANIFEST_PATH)
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

export const README_SCREENSHOT_CONTRACT = captureContract(loadFeatureScreenshotManifest(), README_CAPTURE_ID)

export function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new Error('PNG is too short to contain an IHDR header')
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Asset does not have a valid PNG signature')
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG does not begin with an IHDR chunk')
  }

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0) {
    throw new Error('PNG width and height must be positive')
  }

  return { width, height }
}

export function extractFeatureScreenshotIncludes(source, file = '<source>') {
  const includes = []

  for (const match of source.matchAll(FEATURE_INCLUDE_PATTERN)) {
    const { attributes, duplicates } = parseAttributes(match[1])
    includes.push({
      file,
      line: lineAt(source, match.index),
      attributes,
      duplicates,
    })
  }

  return includes
}

export function collectFeatureScreenshotIncludes(root = repositoryRoot) {
  const includes = []
  const docsDirectory = path.join(root, 'docs')
  for (const file of listDocumentationSources(docsDirectory)) {
    includes.push(
      ...extractFeatureScreenshotIncludes(fs.readFileSync(file, 'utf8'), displayPath(root, file)),
    )
  }
  return includes
}

function validateLocator(locator, prefix) {
  const errors = []
  if (!isRecord(locator)) {
    return [`${prefix}: target locator must be an object`]
  }

  if (!['css', 'text', 'role'].includes(locator.kind)) {
    errors.push(`${prefix}: target locator kind must be css, text, or role`)
    return errors
  }
  if (typeof locator.value !== 'string' || !locator.value.trim()) {
    errors.push(`${prefix}: target locator value must be non-empty`)
  }
  if (locator.within !== undefined && (typeof locator.within !== 'string' || !locator.within.trim())) {
    errors.push(`${prefix}: target locator within scope must be a non-empty CSS selector`)
  }
  if (locator.kind === 'role') {
    if (typeof locator.name !== 'string' || !locator.name.trim()) {
      errors.push(`${prefix}: role locator requires a non-empty name`)
    }
    if (locator.exact !== true) {
      errors.push(`${prefix}: role locator must set exact to true`)
    }
  }
  if (locator.kind === 'text' && locator.exact !== true) {
    errors.push(`${prefix}: text locator must set exact to true`)
  }
  return errors
}

function validateCapture(captureId, capture, root) {
  const errors = []
  const prefix = `${FEATURE_SCREENSHOT_MANIFEST_PATH}: capture "${captureId}"`
  if (!/^[a-z][a-z0-9-]*$/.test(captureId)) {
    errors.push(`${prefix}: id must use lower-case letters, numbers, and hyphens`)
  }
  if (!isRecord(capture)) {
    return [`${prefix}: definition must be an object`]
  }
  if (typeof capture.asset !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.png$/.test(capture.asset)) {
    errors.push(`${prefix}: asset must be a safe PNG filename inside docs/assets`)
  }
  for (const field of ['width', 'height', 'viewportWidth', 'viewportHeight']) {
    if (!Number.isInteger(capture[field]) || capture[field] <= 0) {
      errors.push(`${prefix}: ${field} must be a positive integer`)
    }
  }
  if (capture.width !== capture.viewportWidth || capture.height !== capture.viewportHeight) {
    errors.push(`${prefix}: image dimensions must match the deterministic viewport dimensions`)
  }
  if (typeof capture.state !== 'string' || capture.state.trim().length < 20) {
    errors.push(`${prefix}: state must describe the genuine UI state being captured`)
  }
  if (typeof capture.captureScript !== 'string' || !capture.captureScript.trim()) {
    errors.push(`${prefix}: captureScript must name the reproducible capture entry point`)
  } else {
    const script = path.resolve(root, capture.captureScript)
    if (
      !script.startsWith(`${path.resolve(root)}${path.sep}`) ||
      !fs.existsSync(script) ||
      !fs.statSync(script).isFile()
    ) {
      errors.push(`${prefix}: captureScript "${capture.captureScript}" does not exist inside the repository`)
    }
  }

  if (typeof capture.asset === 'string' && /^[a-z0-9][a-z0-9._-]*\.png$/.test(capture.asset)) {
    const assetPath = path.join(root, 'docs', 'assets', capture.asset)
    if (!fs.existsSync(assetPath)) {
      errors.push(`${prefix}: docs/assets/${capture.asset} does not exist`)
    } else {
      try {
        const dimensions = readPngDimensions(fs.readFileSync(assetPath))
        if (dimensions.width !== capture.width || dimensions.height !== capture.height) {
          errors.push(
            `${prefix}: docs/assets/${capture.asset} is ${dimensions.width}x${dimensions.height}, expected ${capture.width}x${capture.height}`,
          )
        }
      } catch (error) {
        errors.push(`${prefix}: docs/assets/${capture.asset}: ${error.message}`)
      }
    }
  }
  return errors
}

function validateFeatureDefinition(featureId, feature, manifest) {
  const errors = []
  const prefix = `${FEATURE_SCREENSHOT_MANIFEST_PATH}: feature "${featureId}"`
  if (!/^[a-z][a-z0-9-]*$/.test(featureId)) {
    errors.push(`${prefix}: id must use lower-case letters, numbers, and hyphens`)
  }
  if (!isRecord(feature)) {
    return [`${prefix}: definition must be an object`]
  }
  if (!manifest.captures?.[feature.capture]) {
    errors.push(`${prefix}: references unknown capture "${feature.capture ?? ''}"`)
  }
  if (!['card', 'inline', 'overview'].includes(feature.variant)) {
    errors.push(`${prefix}: variant must be card, inline, or overview`)
  }
  if (typeof feature.alt !== 'string' || feature.alt.trim().length < 20) {
    errors.push(`${prefix}: alt text must describe the visible feature state`)
  }
  if (typeof feature.title !== 'string' || !feature.title.trim()) {
    errors.push(`${prefix}: title must be non-empty`)
  }
  if (typeof feature.caption !== 'string' || feature.caption.trim().length < 20) {
    errors.push(`${prefix}: caption must state what the capture proves`)
  }

  const viewBox = typeof feature.viewBox === 'string' ? feature.viewBox.trim().split(/\s+/).map(Number) : []
  const validViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite)
  if (!validViewBox) {
    errors.push(`${prefix}: viewBox must contain four finite numbers`)
    return errors
  }
  const [cropX, cropY, cropWidth, cropHeight] = viewBox
  if (cropWidth <= 0 || cropHeight <= 0) {
    errors.push(`${prefix}: viewBox width and height must be positive`)
  }
  if (numberValue(feature.width) !== cropWidth || numberValue(feature.height) !== cropHeight) {
    errors.push(`${prefix}: width and height must match the viewBox crop dimensions`)
  }
  const capture = manifest.captures?.[feature.capture]
  if (
    capture &&
    (cropX < 0 || cropY < 0 || cropX + cropWidth > capture.width || cropY + cropHeight > capture.height)
  ) {
    errors.push(`${prefix}: viewBox "${feature.viewBox}" exceeds capture "${feature.capture}"`)
  }

  if (!Array.isArray(feature.targets) || feature.targets.length < 1 || feature.targets.length > 3) {
    errors.push(`${prefix}: targets must contain between one and three verified controls`)
    return errors
  }
  const markerRadius = feature.variant === 'overview' ? 18 : 15
  feature.targets.forEach((target, index) => {
    const targetPrefix = `${prefix}, target ${index + 1}`
    if (!isRecord(target)) {
      errors.push(`${targetPrefix}: definition must be an object`)
      return
    }
    const x = numberValue(target.x)
    const y = numberValue(target.y)
    if (x === undefined || y === undefined) {
      errors.push(`${targetPrefix}: x and y must be finite numbers`)
    } else if (
      x < cropX + markerRadius ||
      x > cropX + cropWidth - markerRadius ||
      y < cropY + markerRadius ||
      y > cropY + cropHeight - markerRadius
    ) {
      errors.push(`${targetPrefix}: marker at ${x},${y} is clipped by viewBox "${feature.viewBox}"`)
    }
    if (typeof target.text !== 'string' || target.text.trim().length < 8) {
      errors.push(`${targetPrefix}: text must specifically identify the visible control`)
    }
    errors.push(...validateLocator(target.locator, targetPrefix))
  })
  return errors
}

export function validateFeatureScreenshotManifest(manifest, { root = repositoryRoot } = {}) {
  const errors = []
  if (!isRecord(manifest)) {
    return [`${FEATURE_SCREENSHOT_MANIFEST_PATH}: root must be an object`]
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(`${FEATURE_SCREENSHOT_MANIFEST_PATH}: schemaVersion must be 1`)
  }
  if (!isRecord(manifest.captures) || Object.keys(manifest.captures).length === 0) {
    errors.push(`${FEATURE_SCREENSHOT_MANIFEST_PATH}: captures must be a non-empty object`)
  }
  if (!isRecord(manifest.features) || Object.keys(manifest.features).length === 0) {
    errors.push(`${FEATURE_SCREENSHOT_MANIFEST_PATH}: features must be a non-empty object`)
  }

  const assets = new Map()
  for (const [captureId, capture] of Object.entries(manifest.captures ?? {})) {
    errors.push(...validateCapture(captureId, capture, root))
    if (typeof capture?.asset === 'string') {
      const prior = assets.get(capture.asset)
      if (prior) {
        errors.push(
          `${FEATURE_SCREENSHOT_MANIFEST_PATH}: captures "${prior}" and "${captureId}" reuse asset "${capture.asset}"`,
        )
      } else {
        assets.set(capture.asset, captureId)
      }
    }
  }
  for (const [featureId, feature] of Object.entries(manifest.features ?? {})) {
    errors.push(...validateFeatureDefinition(featureId, feature, manifest))
  }
  for (const captureId of Object.keys(manifest.captures ?? {})) {
    if (!Object.values(manifest.features ?? {}).some((feature) => feature?.capture === captureId)) {
      errors.push(`${FEATURE_SCREENSHOT_MANIFEST_PATH}: capture "${captureId}" is not used by any feature`)
    }
  }
  return errors
}

function validateFeatureReference(include, manifest) {
  const errors = []
  const prefix = `${include.file}:${include.line}`
  for (const duplicate of include.duplicates) {
    errors.push(`${prefix}: duplicate feature-screenshot attribute "${duplicate}"`)
  }
  for (const attribute of Object.keys(include.attributes)) {
    if (attribute !== 'id') {
      errors.push(`${prefix}: feature-screenshot metadata belongs in the manifest, not attribute "${attribute}"`)
    }
  }
  const id = include.attributes.id
  if (!id?.trim()) {
    errors.push(`${prefix}: feature-screenshot is missing non-empty "id"`)
  } else if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    errors.push(`${prefix}: id "${id}" must use lower-case letters, numbers, and hyphens`)
  } else if (!manifest.features?.[id]) {
    errors.push(`${prefix}: feature-screenshot references unknown manifest feature "${id}"`)
  }
  return errors
}

export function validateFeatureScreenshot(include, manifest = loadFeatureScreenshotManifest()) {
  const errors = validateFeatureReference(include, manifest)
  const id = include.attributes.id
  if (id && manifest.features?.[id]) {
    errors.push(...validateFeatureDefinition(id, manifest.features[id], manifest))
  }
  return errors
}

export function validateFeatureScreenshotTemplate(source) {
  const errors = []
  const requiredFragments = [
    'site.data.feature_screenshots.features[include.id]',
    'site.data.feature_screenshots.captures[screenshot.capture]',
    '{{ screenshot_asset | relative_url }}',
    'width="{{ capture.width }}"',
    'height="{{ capture.height }}"',
    '{{ screenshot.alt | escape }}',
    'aria-labelledby="{{ include.id | escape }}-title"',
    '{% for target in screenshot.targets %}',
  ]
  for (const fragment of requiredFragments) {
    if (!source.includes(fragment)) {
      errors.push(`docs/_includes/feature-screenshot.html: missing manifest contract fragment ${fragment}`)
    }
  }
  return errors
}

export function validateDocsScreenshots({
  root = repositoryRoot,
  requiredContextFiles = REQUIRED_CONTEXT_FILES,
} = {}) {
  const errors = []
  let manifest
  try {
    manifest = loadFeatureScreenshotManifest(root)
  } catch (error) {
    return {
      errors: [`${FEATURE_SCREENSHOT_MANIFEST_PATH}: ${error.message}`],
      screenshotCount: 0,
      captureCount: 0,
    }
  }
  errors.push(...validateFeatureScreenshotManifest(manifest, { root }))

  const templatePath = path.join(root, 'docs', '_includes', 'feature-screenshot.html')
  if (!fs.existsSync(templatePath)) {
    errors.push('docs/_includes/feature-screenshot.html: include template does not exist')
  } else {
    errors.push(...validateFeatureScreenshotTemplate(fs.readFileSync(templatePath, 'utf8')))
  }

  const includes = collectFeatureScreenshotIncludes(root)
  const includesByFile = new Map()
  for (const include of includes) {
    errors.push(...validateFeatureReference(include, manifest))
    const current = includesByFile.get(include.file) ?? []
    current.push(include)
    includesByFile.set(include.file, current)
  }

  const ids = new Map()
  for (const include of includes) {
    const id = include.attributes.id
    if (!id) {
      continue
    }
    const previous = ids.get(id)
    if (previous) {
      errors.push(`${include.file}:${include.line}: duplicate screenshot id "${id}" first used at ${previous}`)
    } else {
      ids.set(id, `${include.file}:${include.line}`)
    }
  }
  for (const featureId of Object.keys(manifest.features ?? {})) {
    if (!ids.has(featureId)) {
      errors.push(`${FEATURE_SCREENSHOT_MANIFEST_PATH}: feature "${featureId}" is not referenced by documentation`)
    }
  }
  for (const requiredFile of requiredContextFiles) {
    if ((includesByFile.get(requiredFile) ?? []).length === 0) {
      errors.push(`${requiredFile}: must include at least one contextual feature screenshot`)
    }
  }

  return {
    errors,
    screenshotCount: includes.length,
    captureCount: Object.keys(manifest.captures ?? {}).length,
  }
}

function main() {
  const result = validateDocsScreenshots()
  if (result.errors.length > 0) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
    return
  }

  console.log(
    `Validated ${result.screenshotCount} annotated feature views against ${result.captureCount} reproducible capture asset(s).`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main()
}
