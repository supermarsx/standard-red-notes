import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UIKit
import WebKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    configurePinning()
    disableURLCache()
    clearWebEditorCache()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()
    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "StandardNotes",
      in: window,
      launchOptions: launchOptions
    )

    window?.rootViewController?.view.backgroundColor = .black
    window?.backgroundColor = .black
    return true
  }

  func application(
    _ application: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    RCTLinkingManager.application(application, open: url, options: options)
  }

  private func disableURLCache() {
    // Cached network responses are not protected by NSFileProtectionComplete.
    URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, diskPath: nil)
  }

  private func clearWebEditorCache() {
    // Clear the web editor cache after every app update.
    let defaults = UserDefaults.standard
    let lastVersionClearKey = "lastVersionClearKey"
    let lastVersionClear = defaults.string(forKey: lastVersionClearKey)

    guard
      let currentVersion = Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String,
      currentVersion != lastVersionClear
    else {
      return
    }

    URLCache.shared.removeAllCachedResponses()
    WKWebsiteDataStore.default().removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
      modifiedSince: Date(timeIntervalSince1970: 0)
    ) {}
    defaults.set(currentVersion, forKey: lastVersionClearKey)
  }

  private func configurePinning() {
    // Self-hosted fork: TLS certificate pinning against hosted Standard Notes
    // domains has been removed because it would block an operator's own server.
    // The standard OS trust store is used unless an operator adds their own
    // TrustKit policy here.
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
