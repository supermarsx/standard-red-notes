import { readFileSync } from 'fs'
import { resolve } from 'path'

const appRoot = resolve(__dirname, '../../../..')
const mobileManifest = JSON.parse(readFileSync(resolve(appRoot, 'packages/mobile/package.json'), 'utf8')) as {
  devDependencies: Record<string, string>
}
const lockfile = readFileSync(resolve(appRoot, 'yarn.lock'), 'utf8')

const patchedDependencies = [
  {
    name: '@standardnotes/react-native-utils',
    source: '@standardnotes/react-native-utils@npm%3A1.0.1',
    patchFile: '@standardnotes-react-native-utils-npm-1.0.1-40c9dd01f0.patch',
  },
  {
    name: 'react-native-fingerprint-scanner',
    source: 'b55d1c0ca627a87a130f758603f12911fbac200f',
    patchFile: 'react-native-fingerprint-scanner-https-c92249c49b.patch',
  },
  {
    name: 'react-native-flag-secure-android',
    source: 'cb08e74583c22a5d912842459b35ebbbb4bcd852',
    patchFile: 'react-native-flag-secure-android-https-2c9d6318d9.patch',
  },
]

describe('Android Gradle dependency patches', () => {
  it.each(patchedDependencies)(
    'pins $name to a tracked Yarn patch that replaces removed jcenter repositories',
    ({ name, source, patchFile }) => {
      const descriptor = mobileManifest.devDependencies[name]
      const patch = readFileSync(resolve(appRoot, '.yarn/patches', patchFile), 'utf8')
      const addedLines = patch.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      const removedLines = patch.split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---'))

      expect(descriptor.startsWith('patch:')).toBe(true)
      expect(descriptor).toContain(source)
      expect(descriptor.endsWith(`#~/.yarn/patches/${patchFile}`)).toBe(true)
      expect(lockfile).toContain(descriptor)
      expect(lockfile).toContain(`"${name}@patch:`)
      expect(addedLines.some((line) => line.includes('mavenCentral()'))).toBe(true)
      expect(addedLines.some((line) => line.includes('jcenter()'))).toBe(false)
      expect(removedLines.some((line) => line.includes('jcenter()'))).toBe(true)
    },
  )

  it('keeps the FIDO SDK compatible with the React Native Kotlin compiler', () => {
    const appBuild = readFileSync(resolve(appRoot, 'packages/mobile/android/app/build.gradle'), 'utf8')

    expect(appBuild).toContain("implementation 'com.google.android.gms:play-services-fido:21.2.0'")
    expect(appBuild).not.toContain("implementation 'com.google.android.gms:play-services-fido:21.3.0'")
  })

  it('keeps react-native-iap lint running around its incompatible Compose detector', () => {
    const descriptor = mobileManifest.devDependencies['react-native-iap']
    const patchFile = 'react-native-iap-npm-15.5.0-f9478cfd8f.patch'
    const patch = readFileSync(resolve(appRoot, '.yarn/patches', patchFile), 'utf8')

    expect(descriptor).toBe(`patch:react-native-iap@npm%3A15.5.0#~/.yarn/patches/${patchFile}`)
    expect(lockfile).toContain(descriptor)
    expect(lockfile).toContain('"react-native-iap@patch:')
    expect(patch).toContain('disable "CoroutineCreationDuringComposition"')
    expect(patch).not.toContain('abortOnError false')
  })
})
