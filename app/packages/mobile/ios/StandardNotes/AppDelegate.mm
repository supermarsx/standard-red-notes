#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <React/RCTLinkingManager.h>
#import <WebKit/WKWebsiteDataStore.h>
#import <TrustKit/TrustKit.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  
  [self configurePinning];
  
  [self disableUrlCache];
  
  [self clearWebEditorCache];
  
  self.moduleName = @"StandardNotes";
  self.dependencyProvider = [RCTAppDependencyProvider new];
  self.initialProps = @{};
  
  BOOL success = [super application:application didFinishLaunchingWithOptions:launchOptions];
  if (success) {
    self.window.rootViewController.view.backgroundColor = [UIColor colorWithWhite:0.0 alpha:1.0];
    self.window.backgroundColor = [UIColor colorWithWhite:0.0 alpha:1.0];
  }
  return success;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}
 
- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

- (void)disableUrlCache {
  // Disable NSURLCache for general network requests. Caches are not protected by NSFileProtectionComplete.
  // Disabling, or implementing a custom subclass are only two solutions. https://stackoverflow.com/questions/27933387/nsurlcache-and-data-protection
  NSURLCache *sharedCache = [[NSURLCache alloc] initWithMemoryCapacity:0 diskCapacity:0 diskPath:nil];
  [NSURLCache setSharedURLCache:sharedCache];
}

- (void)clearWebEditorCache {
  // Clear web editor cache after every app update
  NSString *lastVersionClearKey = @"lastVersionClearKey";
  NSString *lastVersionClear = [[NSUserDefaults standardUserDefaults] objectForKey:lastVersionClearKey];
  NSString *currentVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey: @"CFBundleShortVersionString"];
  if(![currentVersion isEqualToString:lastVersionClear]) {
    // UIWebView
    [[NSURLCache sharedURLCache] removeAllCachedResponses];
    
    // WebKit
    NSSet *websiteDataTypes = [WKWebsiteDataStore allWebsiteDataTypes];
    NSDate *dateFrom = [NSDate dateWithTimeIntervalSince1970:0];
    [[WKWebsiteDataStore defaultDataStore] removeDataOfTypes:websiteDataTypes modifiedSince:dateFrom completionHandler:^{}];
    
    [[NSUserDefaults standardUserDefaults] setObject:currentVersion forKey:lastVersionClearKey];
  }
}

- (void)configurePinning {
  // Self-hosted fork: TLS certificate pinning against the hosted Standard Notes
  // domains (standardnotes.com / standardnotes.org) has been removed. Enforced
  // pinning to SN's certificates would block connections to an operator's own
  // self-hosted server. The standard OS trust store is used instead.
  //
  // Operators who want certificate pinning for their OWN domain can re-enable
  // TrustKit here with their server's domain(s) and public-key (SPKI) hashes.
  //
  // No-op by default.
}

@end
