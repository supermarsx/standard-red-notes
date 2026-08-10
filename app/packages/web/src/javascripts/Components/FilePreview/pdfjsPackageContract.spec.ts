import fs from 'fs'
import path from 'path'

const FIXED_PDFJS_VERSION = '6.2.108'
const PDFJS_RUNTIME_IMPORT = 'pdfjs-dist/legacy/build/pdf.mjs'
const PDFJS_WORKER_IMPORT = 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'

describe('PDF.js preview package contract', () => {
  it('pins the first release that fixes malicious-PDF JavaScript execution', () => {
    const webPackage = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const installedPackage = JSON.parse(fs.readFileSync(require.resolve('pdfjs-dist/package.json'), 'utf8')) as {
      version: string
    }

    expect(webPackage.dependencies['pdfjs-dist']).toBe(FIXED_PDFJS_VERSION)
    expect(installedPackage.version).toBe(FIXED_PDFJS_VERSION)
  })

  it('loads the locally bundled runtime and worker entry points from that package', () => {
    const integrationSource = fs.readFileSync(path.resolve(__dirname, 'pdfjs.ts'), 'utf8')

    expect(() => require.resolve(PDFJS_RUNTIME_IMPORT)).not.toThrow()
    expect(() => require.resolve(PDFJS_WORKER_IMPORT)).not.toThrow()
    expect(integrationSource).toContain(`from '${PDFJS_RUNTIME_IMPORT}'`)
    expect(integrationSource).toContain(`from '${PDFJS_WORKER_IMPORT}'`)
  })
})
