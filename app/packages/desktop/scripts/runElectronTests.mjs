import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appEntry = path.join(desktopDirectory, 'app', 'dist', 'index.js')
const avaCli = path.join(desktopDirectory, 'node_modules', 'ava', 'entrypoints', 'cli.js')
export const electronTestSpecs = Object.freeze([
  'test/backupsManager.spec.ts',
  'test/menus.spec.ts',
  'test/networking.spec.ts',
  'test/spellcheckerManager.spec.ts',
  'test/storage.spec.ts',
  'test/updates.spec.ts',
  'test/window.spec.ts',
])

export function assertElectronTestEnvironment() {
  if (!existsSync(appEntry) || !statSync(appEntry).isFile()) {
    throw new Error(`Electron test bundle is missing: ${appEntry}. Run the desktop build first.`)
  }

  if (!existsSync(avaCli) || !statSync(avaCli).isFile()) {
    throw new Error(`AVA CLI is missing: ${avaCli}. Install the app workspace first.`)
  }
}

export function runElectronTestProcess(spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnProcess(process.execPath, [avaCli, '--serial', '--timeout=60s', ...electronTestSpecs], {
        cwd: desktopDirectory,
        env: {
          ...process.env,
          RUN_ELECTRON_TESTS: '1',
        },
        stdio: 'inherit',
      })
    } catch (error) {
      reject(new Error('Unable to start the Electron test runner.', { cause: error }))
      return
    }

    let settled = false
    const fail = (error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    child.once('error', (error) => {
      fail(new Error('Unable to start the Electron test runner.', { cause: error }))
    })
    child.once('exit', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      if (signal) {
        reject(new Error(`Electron test runner terminated by ${signal}.`))
      } else {
        resolve(code ?? 1)
      }
    })
  })
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    assertElectronTestEnvironment()
    process.exitCode = await runElectronTestProcess()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
