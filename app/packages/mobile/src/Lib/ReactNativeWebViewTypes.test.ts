import { readFileSync } from 'fs'
import { resolve } from 'path'

const appRoot = resolve(__dirname, '../../../..')
const mobileManifest = JSON.parse(readFileSync(resolve(appRoot, 'packages/mobile/package.json'), 'utf8')) as {
  devDependencies: Record<string, string>
}
const lockfile = readFileSync(resolve(appRoot, 'yarn.lock'), 'utf8')

describe('react-native-webview type compatibility', () => {
  it('keeps the default WebView extension props intersectable', () => {
    const patchFile = 'react-native-webview-npm-14.0.1-5188b52144.patch'
    const descriptor = mobileManifest.devDependencies['react-native-webview']
    const patch = readFileSync(resolve(appRoot, '.yarn/patches', patchFile), 'utf8')

    expect(descriptor).toBe(`patch:react-native-webview@npm%3A14.0.1#~/.yarn/patches/${patchFile}`)
    expect(lockfile).toContain(descriptor)
    expect(lockfile).toContain('"react-native-webview@patch:')
    expect(patch).toContain('-declare class WebView<P = undefined> extends Component<WebViewProps & P>')
    expect(patch).toContain('+declare class WebView<P = unknown> extends Component<WebViewProps & P>')
  })
})
