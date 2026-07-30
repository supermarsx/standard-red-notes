#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

export const README_SCREENSHOT_CONTRACT = Object.freeze({
  assetPath: 'docs/assets/readme-screenshot.png',
  siteAssetPath: '/assets/readme-screenshot.png',
  width: 1440,
  height: 900,
})

const REQUIRED_FIELDS = [
  'id',
  'view_box',
  'width',
  'height',
  'alt',
  'title',
  'caption',
  'marker_one_x',
  'marker_one_y',
  'marker_one_text',
]

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
  if (typeof value !== 'string' || value.trim() === '') {
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

export function validateFeatureScreenshot(include, contract = README_SCREENSHOT_CONTRACT) {
  const errors = []
  const prefix = `${include.file}:${include.line}`
  const attributes = include.attributes

  for (const duplicate of include.duplicates) {
    errors.push(`${prefix}: duplicate feature-screenshot attribute "${duplicate}"`)
  }

  for (const field of REQUIRED_FIELDS) {
    if (!attributes[field]?.trim()) {
      errors.push(`${prefix}: feature-screenshot is missing non-empty "${field}"`)
    }
  }

  if (attributes.id && !/^[a-z][a-z0-9-]*$/.test(attributes.id)) {
    errors.push(`${prefix}: id "${attributes.id}" must use lower-case letters, numbers, and hyphens`)
  }

  if (attributes.variant && !['card', 'inline', 'overview'].includes(attributes.variant)) {
    errors.push(`${prefix}: variant "${attributes.variant}" must be card, inline, or overview`)
  }

  if (attributes.alt && (attributes.alt.trim().length < 20 || /^(?:image|screenshot|app screenshot)$/i.test(attributes.alt.trim()))) {
    errors.push(`${prefix}: alt text must describe the visible crop rather than naming a generic image`)
  }

  const viewBox = attributes.view_box?.trim().split(/\s+/).map(Number)
  const validViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite)

  if (!validViewBox) {
    if (attributes.view_box) {
      errors.push(`${prefix}: view_box must contain four finite numbers`)
    }
    return errors
  }

  const [cropX, cropY, cropWidth, cropHeight] = viewBox
  if (cropWidth <= 0 || cropHeight <= 0) {
    errors.push(`${prefix}: view_box width and height must be positive`)
  }
  if (
    cropX < 0 ||
    cropY < 0 ||
    cropX + cropWidth > contract.width ||
    cropY + cropHeight > contract.height
  ) {
    errors.push(
      `${prefix}: view_box "${attributes.view_box}" exceeds the ${contract.width}x${contract.height} source image`,
    )
  }

  const declaredWidth = numberValue(attributes.width)
  const declaredHeight = numberValue(attributes.height)
  if (declaredWidth !== cropWidth || declaredHeight !== cropHeight) {
    errors.push(`${prefix}: width and height must match the view_box crop dimensions`)
  }

  const markerRadius = attributes.variant === 'overview' ? 18 : 15
  let priorMarkerPresent = true

  for (const [index, markerName] of ['one', 'two', 'three'].entries()) {
    const fields = [`marker_${markerName}_x`, `marker_${markerName}_y`, `marker_${markerName}_text`]
    const presentFields = fields.filter((field) => attributes[field]?.trim())
    const markerPresent = presentFields.length > 0

    if (index === 0 && !markerPresent) {
      continue
    }
    if (markerPresent && presentFields.length !== fields.length) {
      errors.push(`${prefix}: marker ${index + 1} requires x, y, and text together`)
      priorMarkerPresent = false
      continue
    }
    if (markerPresent && !priorMarkerPresent) {
      errors.push(`${prefix}: marker ${index + 1} cannot appear before marker ${index}`)
    }
    if (!markerPresent) {
      priorMarkerPresent = false
      continue
    }

    const markerX = numberValue(attributes[fields[0]])
    const markerY = numberValue(attributes[fields[1]])
    if (markerX === undefined || markerY === undefined) {
      errors.push(`${prefix}: marker ${index + 1} coordinates must be finite numbers`)
      continue
    }

    const markerInsideCrop =
      markerX >= cropX + markerRadius &&
      markerX <= cropX + cropWidth - markerRadius &&
      markerY >= cropY + markerRadius &&
      markerY <= cropY + cropHeight - markerRadius
    if (!markerInsideCrop) {
      errors.push(`${prefix}: marker ${index + 1} at ${markerX},${markerY} is clipped by the declared view_box`)
    }

    if (attributes[fields[2]].trim().length < 8) {
      errors.push(`${prefix}: marker ${index + 1} text is too short to identify the visible target`)
    }
  }

  return errors
}

export function validateFeatureScreenshotTemplate(source, contract = README_SCREENSHOT_CONTRACT) {
  const errors = []
  const imageTag = source.match(/<image\b[\s\S]*?\/>/)?.[0]

  if (!imageTag) {
    return ['docs/_includes/feature-screenshot.html: missing SVG image element']
  }
  if (!imageTag.includes(`'${contract.siteAssetPath}' | relative_url`)) {
    errors.push(
      `docs/_includes/feature-screenshot.html: image must reference ${contract.siteAssetPath} through relative_url`,
    )
  }

  const imageAttributes = parseAttributes(imageTag).attributes
  if (numberValue(imageAttributes.width) !== contract.width || numberValue(imageAttributes.height) !== contract.height) {
    errors.push(
      `docs/_includes/feature-screenshot.html: SVG image dimensions must be ${contract.width}x${contract.height}`,
    )
  }
  if (!source.includes('{{ include.alt | escape }}')) {
    errors.push('docs/_includes/feature-screenshot.html: include.alt must be escaped into accessible text')
  }
  if (!source.includes('aria-labelledby="{{ include.id | escape }}-title"')) {
    errors.push('docs/_includes/feature-screenshot.html: SVG must use its unique title as the accessible name')
  }

  return errors
}

export function validateDocsScreenshots({
  root = repositoryRoot,
  contract = README_SCREENSHOT_CONTRACT,
  requiredContextFiles = REQUIRED_CONTEXT_FILES,
} = {}) {
  const errors = []
  const asset = path.join(root, contract.assetPath)

  if (!fs.existsSync(asset)) {
    return {
      errors: [`${contract.assetPath}: referenced screenshot asset does not exist`],
      screenshotCount: 0,
    }
  }

  try {
    const dimensions = readPngDimensions(fs.readFileSync(asset))
    if (dimensions.width !== contract.width || dimensions.height !== contract.height) {
      errors.push(
        `${contract.assetPath}: expected ${contract.width}x${contract.height}, got ${dimensions.width}x${dimensions.height}`,
      )
    }
  } catch (error) {
    errors.push(`${contract.assetPath}: ${error.message}`)
  }

  const templatePath = path.join(root, 'docs', '_includes', 'feature-screenshot.html')
  if (!fs.existsSync(templatePath)) {
    errors.push('docs/_includes/feature-screenshot.html: include template does not exist')
  } else {
    errors.push(...validateFeatureScreenshotTemplate(fs.readFileSync(templatePath, 'utf8'), contract))
  }

  const docsDirectory = path.join(root, 'docs')
  const includes = []
  const includesByFile = new Map()

  for (const file of listDocumentationSources(docsDirectory)) {
    const relativeFile = displayPath(root, file)
    const extracted = extractFeatureScreenshotIncludes(fs.readFileSync(file, 'utf8'), relativeFile)
    includes.push(...extracted)
    includesByFile.set(relativeFile, extracted)
  }

  const ids = new Map()
  for (const include of includes) {
    errors.push(...validateFeatureScreenshot(include, contract))
    const id = include.attributes.id
    if (id) {
      const previous = ids.get(id)
      if (previous) {
        errors.push(`${include.file}:${include.line}: duplicate screenshot id "${id}" first used at ${previous}`)
      } else {
        ids.set(id, `${include.file}:${include.line}`)
      }
    }
  }

  for (const requiredFile of requiredContextFiles) {
    if ((includesByFile.get(requiredFile) ?? []).length === 0) {
      errors.push(`${requiredFile}: must include at least one contextual feature screenshot`)
    }
  }

  return { errors, screenshotCount: includes.length }
}

function main() {
  const result = validateDocsScreenshots()
  if (result.errors.length > 0) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
    return
  }

  console.log(
    `Validated ${result.screenshotCount} documented screenshot crops against ${README_SCREENSHOT_CONTRACT.width}x${README_SCREENSHOT_CONTRACT.height} ${README_SCREENSHOT_CONTRACT.assetPath}.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main()
}
