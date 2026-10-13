import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const safeLogHelperFiles = [
  "server/packages/auth/src/Domain/Logging/SafeLog.ts",
  "server/packages/api-gateway/src/Service/Logging/SafeLog.ts",
  "app/packages/utils/src/Domain/Logger/SafeLog.ts",
];
const safeLogKernelStart = "const Redacted = '[REDACTED]'";
const safeLogKernelEnd = "// SAFE_LOG_SHARED_KERNEL_END";

const contractSourceFiles = [
  ...safeLogHelperFiles,
  "server/packages/auth/src/Domain/Auth/AuthResponseFactory20161215.ts",
  "server/packages/auth/src/Domain/Auth/AuthResponseFactory20200115.ts",
  "server/packages/auth/src/Domain/Encryption/CrypterNode.ts",
  "server/packages/auth/src/Domain/UseCase/AuthenticateUser.ts",
  "server/packages/auth/src/Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken.ts",
  "server/packages/auth/src/Domain/UseCase/GetUserKeyParams/GetUserKeyParams.ts",
  "server/packages/auth/src/Infra/InversifyExpressUtils/Middleware/ApiGatewayOfflineAuthMiddleware.ts",
  "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedSubscriptionTokensController.ts",
  "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedOfflineController.ts",
  "server/packages/api-gateway/src/Controller/AuthMiddleware.ts",
  "server/packages/api-gateway/src/Controller/SubscriptionTokenAuthMiddleware.ts",
  "server/packages/api-gateway/src/Controller/RateLimitMiddleware.ts",
  "server/packages/api-gateway/src/Controller/UserRateLimitMiddleware.ts",
  "server/packages/api-gateway/src/Controller/v1/CollaborationController.ts",
  "server/packages/api-gateway/bin/server.ts",
  "server/packages/api-gateway/src/Service/Http/HttpServiceProxy.ts",
  "server/packages/api-gateway/src/Service/gRPC/GRPCServiceProxy.ts",
  "server/packages/api-gateway/src/Service/gRPC/GRPCSyncingServerServiceProxy.ts",
  "server/packages/api-gateway/src/Service/DavBridge/SecretString.ts",
  "server/packages/api-gateway/src/Service/EmailDelivery/EmailDeliveryRuntime.ts",
  "server/packages/websocket-gateway/src/index.ts",
  "server/packages/websocket-gateway/src/logger.ts",
  "server/packages/websocket-gateway/src/gateway.ts",
  "server/packages/websocket-gateway/src/redisBridge.ts",
  "server/packages/websocket-gateway/src/sqsConsumer.ts",
  "server/packages/home-server/src/Server/HomeServer.ts",
  "server/packages/home-server/src/Server/HomeServerRuntime.ts",
  "server/packages/home-server/src/Server/WebSocketRedisBridge.ts",
  "app/packages/api/src/Domain/Http/HttpService.ts",
  "app/packages/api/src/Domain/Http/FetchRequestHandler.ts",
  "app/packages/encryption/src/Domain/Operator/OperatorWrapper.ts",
  "app/packages/mobile/WebFrame/MessageSender.template.js",
  "app/packages/mobile/index.js",
  "app/packages/mobile/src/Lib/MobileDevice.ts",
  "app/packages/mobile/src/Lib/MobileWebViewSecurity.ts",
  "app/packages/mobile/src/MobileWebAppContainer.tsx",
  "app/packages/snjs/lib/Log.ts",
  "app/packages/snjs/lib/Services/ComponentManager/ComponentViewer.ts",
  "app/packages/snjs/lib/Services/ComponentManager/ComponentManager.ts",
  "app/packages/snjs/lib/Services/Sync/SyncService.ts",
  "app/packages/utils/src/Domain/Logger/Logger.ts",
  "app/packages/utils/src/Domain/Utils/Utils.ts",
];

export const guardedRuntimeRoots = Object.freeze([
  "app/packages/api",
  "app/packages/encryption",
  "app/packages/mobile",
  "app/packages/snjs",
  "app/packages/utils",
  "cli",
  "mcp",
  "openclaw",
  "server/packages",
]);
const liveSourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const ignoredPathSegments = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "e2e",
  "example",
  "examples",
  "fixtures",
  "generated",
  "html",
  "migrations",
  "mocha",
  "node_modules",
  "scripts",
  "test",
  "tests",
]);
const ignoredFilePattern =
  /(?:^|\/)(?:[^/]+\.)?(?:spec|test)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+(?:\.d\.ts|\.min\.js)$/;

/**
 * Residual dynamic log calls are allowed only when they have been reviewed and
 * recorded here with a stable call fragment and a reason. The validator rejects
 * both new findings and stale entries, so this is an auditable exception list
 * rather than a blanket suppression.
 */
export const reviewedSafeLoggingAllowlist = [
  {
    file: "server/packages/websocket-gateway/src/gateway.ts",
    line: 1625,
    rule: "forwarded-message-not-literal",
    call: [
      "logRefusal(",
      "      `[ws-sync] ${event}: unmet preconditions ${reasons.join(', ') || 'none'}`,",
      "      `${event}:${reasons.join()}`,",
      "      {",
      "        reasons,",
      "      },",
      "    )",
    ].join("\n"),
    reason:
      "`event` is a parameter of logSyncRefusal, whose only callers pass string literals, and `reasons` is a SyncUnavailabilityReason[], a closed union of constants. Nothing a client sent reaches the message.",
  },
  {
    file: "server/packages/websocket-gateway/src/gateway.ts",
    line: 1778,
    rule: "forwarded-message-not-literal",
    call: [
      "logRefusal(",
      "          `[ws-sync] connection rejected: ${rejection}`,",
      "          `connection:${rejection}:${unavailability.join()}`,",
      "          unavailability.length > 0 ? { rejection, reasons: unavailability } : { rejection },",
      "        )",
    ].join("\n"),
    reason:
      "`rejection` is a SocketRejectionCode, a member of the closed SOCKET_REJECTION_CODES tuple, chosen by the gateway; the URL and origin it was derived from are not logged.",
  },
];

function isProtectedLoggingSource(_file) {
  // Every source supplied to the repository-wide validator is protected. The
  // production invocation supplies the complete discovered authored-runtime
  // set; tests may supply synthetic paths to prove the same rule boundaries.
  return true;
}

function isGuardedAppLoggingSource(file) {
  return guardedRuntimeRoots.some(
    (root) =>
      root.startsWith("app/") && (file === root || file.startsWith(`${root}/`)),
  );
}

const forbiddenRules = [
  {
    id: "raw-jwt-log",
    pattern: /Created JWT token[\s\S]{0,120}\$\{token\}/,
  },
  {
    id: "raw-session-payload-log",
    pattern: /Created session payload for user/,
  },
  {
    id: "raw-auth-dto-log",
    pattern: /JSON\.stringify\(dto\)/,
  },
  {
    id: "raw-revoked-token-log",
    pattern: /Session has been revoked:[^\n]*authTokenFromHeaders/,
  },
  {
    id: "raw-offline-token-log",
    pattern: /Created offline subscription token:\s*%O/,
  },
  {
    id: "raw-decoded-offline-token-log",
    pattern: /decoded token\s*%O/,
  },
  {
    id: "raw-key-params-dto-log",
    pattern: /given parameters:\s*%O['"`]?\s*,\s*dto/,
  },
  {
    id: "email-key-params-log",
    pattern:
      /(?:dto|user)\.email[^;\n]*(?:logger|Authentication)|logger[^\n]*(?:dto|user)\.email/,
  },
  {
    id: "raw-encryption-value-log",
    pattern:
      /Decrypting for user value|Decrypted user server key|Encrypted value:\s*%O/,
  },
  {
    id: "serialized-error-log",
    pattern:
      /logger\.(?:debug|info|warn|error)\([^\n]*JSON\.stringify\(error\)/,
  },
  {
    id: "raw-error-object-log",
    pattern:
      /logger\.(?:debug|info|warn|error)\([^\n]*Response error:[^\n]*(?:%O|error)/,
  },
  {
    id: "raw-http-request-response-log",
    pattern:
      /logger\.error\(\s*['"`]Request failed['"`]\s*,\s*httpRequest\s*,\s*response\s*\)/,
  },
  {
    id: "raw-component-session-log",
    pattern:
      /logger\.info\([^\n]*(?:this\.sessionKey|['"`]sessionKey['"`]\s*,)/,
  },
  {
    id: "raw-component-object-log",
    pattern:
      /logger\.info\([^\n]*(?:['"`]Constructor['"`]\s*,\s*this|['"`]Destroying['"`]\s*,\s*this|,\s*items\s*,\s*message|,\s*message\s*,\s*this|,\s*data\s*\))/,
  },
  {
    id: "raw-sync-response-log",
    pattern:
      /logger\.debug\(\s*['"`](?:Offline Sync Response|Sync Error)['"`]\s*,\s*response/,
  },
  {
    id: "subscription-token-in-internal-path",
    pattern:
      /authServerUrl\}\/(?:offline\/)?subscription-tokens\/\$\{subscriptionToken\}\/validate/,
  },
  {
    id: "websocket-session-identifier-log",
    pattern:
      /logger\.(?:debug|info|warn|error)\([\s\S]{0,160}(?:session|excludeSession)=\$\{/,
  },
  {
    id: "websocket-raw-error-message",
    pattern:
      /logger\.(?:debug|info|warn|error)\([\s\S]{0,160}(?:err|error)\s+instanceof\s+Error\s*\?\s*(?:err|error)\.message/,
  },
  {
    id: "home-websocket-raw-error",
    pattern:
      /WebSocketRedisBridge[^;\n]*(?:\$\{[^}]*error[^}]*\.message|error:\s*%O)|logger\.error\(\s*['"`]WebSocketRedisBridge[^;\n]*%O/,
  },
  {
    id: "mobile-bridge-raw-message",
    pattern:
      /Error parsing message from React Native['"`]\s*,\s*message|console\.log\(\s*['"`]onGeneralMessage['"`]\s*,\s*JSON\.stringify\(message\)\s*\)|onError=\{\(err\)\s*=>\s*console\.error\([^)]*,\s*err\)/,
  },
  {
    id: "crypto-exception-message-log",
    pattern: /Error decrypting payload[\s\S]{0,200}(?:\.message|String\()/,
  },
  {
    id: "interpolated-error-message-log",
    pattern:
      /(?:logger|routingLogger)\.(?:debug|info|warn|error)\(\s*`[^`]*\$\{[^}]*(?:err|error)[^}]*\.message\}/,
  },
  {
    id: "raw-mobile-console-arguments",
    pattern:
      /console\.log\(\s*args\s*\)|initializeNotifications\(\)\.catch\(\s*console\.error\s*\)|this\.consoleLog\(\s*(?:error|error_1)\s*\)|this\.consoleLog\(\s*`[^`]*error[^`]*\.message/,
  },
  {
    id: "raw-error-stack-log",
    pattern:
      /logger\.error\(\s*`\$\{error\.stack\}`|console\.error\([^)\n]*\.stack\)/,
  },
  {
    id: "raw-app-snlog-console-binding",
    pattern: /SNLog\.on(?:Error|Log)\s*=\s*console\.(?:error|log|warn)/,
  },
  {
    id: "raw-mobile-web-log-forwarding",
    pattern:
      /ReactNativeWebView\.postMessage\([^;\n]*\[web log\][^;\n]*args\.join/,
  },
  {
    id: "raw-console-error-instance",
    pattern: /console\.(?:error|log|warn)\(\s*(?:new\s+)?Error\(/,
  },
];

export const requiredRules = [
  // `errorName(error)` is accepted below as a projection of an error, not the
  // error. That is only true of this implementation: a class name that matches
  // a short identifier pattern, or a constant.
  {
    id: "email-delivery-error-name-projection",
    file: "server/packages/api-gateway/src/Service/EmailDelivery/EmailDeliveryRuntime.ts",
    pattern:
      /function errorName\(error: unknown\): string \{\s*return error instanceof Error && \/\^\[A-Za-z\]\[A-Za-z0-9_\.-\]\{0,63\}\$\/\.test\(error\.name\) \? error\.name : 'UnknownError'\s*\}/,
  },
  // The DAV bridge holds an external account's password in a SecretString so
  // that none of the ways a value is implicitly turned into text can spill it.
  // Each of these pins one of those ways answering the redaction marker.
  {
    id: "dav-secret-held-in-private-field",
    file: "server/packages/api-gateway/src/Service/DavBridge/SecretString.ts",
    pattern: /readonly #value: string/,
  },
  {
    id: "dav-secret-redacted-to-string",
    file: "server/packages/api-gateway/src/Service/DavBridge/SecretString.ts",
    pattern: /toString\(\): string \{\s*return REDACTED\s*\}/,
  },
  {
    id: "dav-secret-redacted-to-json",
    file: "server/packages/api-gateway/src/Service/DavBridge/SecretString.ts",
    pattern: /toJSON\(\): string \{\s*return REDACTED\s*\}/,
  },
  {
    id: "dav-secret-redacted-on-inspect",
    file: "server/packages/api-gateway/src/Service/DavBridge/SecretString.ts",
    pattern:
      /\[Symbol\.for\('nodejs\.util\.inspect\.custom'\)\]\(\): string \{\s*return REDACTED\s*\}/,
  },
  {
    id: "gateway-fixed-online-subscription-route",
    file: "server/packages/api-gateway/src/Controller/SubscriptionTokenAuthMiddleware.ts",
    pattern: /\$\{this\.authServerUrl\}\/subscription-tokens\/validate/,
  },
  {
    id: "gateway-fixed-offline-subscription-route",
    file: "server/packages/api-gateway/src/Controller/SubscriptionTokenAuthMiddleware.ts",
    pattern:
      /\$\{this\.authServerUrl\}\/offline\/subscription-tokens\/validate/,
  },
  {
    id: "gateway-subscription-header",
    file: "server/packages/api-gateway/src/Controller/SubscriptionTokenAuthMiddleware.ts",
    pattern: /x-subscription-token/,
  },
  {
    id: "auth-fixed-online-subscription-route",
    file: "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedSubscriptionTokensController.ts",
    pattern: /@httpPost\('\/validate'\)/,
  },
  {
    id: "auth-legacy-online-subscription-route",
    file: "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedSubscriptionTokensController.ts",
    pattern: /@httpPost\('\/:token\/validate'\)/,
  },
  {
    id: "auth-fixed-offline-subscription-route",
    file: "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedOfflineController.ts",
    pattern: /@httpPost\('\/subscription-tokens\/validate'\)/,
  },
  {
    id: "auth-legacy-offline-subscription-route",
    file: "server/packages/auth/src/Infra/InversifyExpressUtils/AnnotatedOfflineController.ts",
    pattern: /@httpPost\('\/subscription-tokens\/:token\/validate'\)/,
  },
  // The standalone gateway's console boundary lives in `logger.ts`, not
  // `index.ts`: `createConsoleLogger` is the only place in the package allowed
  // to touch `console`, and every level funnels through one `write()` that
  // spreads `safeLogArguments`. These four contracts pin that shape — the
  // single redaction choke point, and each level reaching the console method it
  // claims to. Aimed at `index.ts` they matched nothing and protected nothing.
  {
    id: "standalone-websocket-redaction-boundary",
    file: "server/packages/websocket-gateway/src/logger.ts",
    pattern: /target\([^;\n]*\.\.\.safeLogArguments\(args\)\)/,
  },
  {
    id: "standalone-websocket-info-boundary",
    file: "server/packages/websocket-gateway/src/logger.ts",
    pattern: /info:\s*\(\.\.\.args\)\s*=>\s*write\('info',\s*sink\.log\.bind\(sink\),\s*args\)/,
  },
  {
    id: "standalone-websocket-warn-boundary",
    file: "server/packages/websocket-gateway/src/logger.ts",
    pattern: /warn:\s*\(\.\.\.args\)\s*=>\s*write\('warn',\s*sink\.warn\.bind\(sink\),\s*args\)/,
  },
  {
    id: "standalone-websocket-error-boundary",
    file: "server/packages/websocket-gateway/src/logger.ts",
    pattern: /error:\s*\(\.\.\.args\)\s*=>\s*write\('error',\s*sink\.error\.bind\(sink\),\s*args\)/,
  },
  {
    id: "gateway-rate-limit-logger-metadata-forwarding",
    file: "server/packages/api-gateway/bin/server.ts",
    pattern:
      /logger:\s*\{\s*warn:\s*\(message:\s*string,\s*metadata\?:\s*Record<string,\s*unknown>\)\s*=>\s*logger\.warn\(message,\s*metadata\)\s*,?\s*\}/,
  },
  {
    id: "gateway-user-rate-limit-logger-metadata-forwarding",
    file: "server/packages/api-gateway/src/Controller/UserRateLimitMiddleware.ts",
    pattern:
      /warn:\s*\(message:\s*string,\s*metadata\?:\s*Record<string,\s*unknown>\)[^=]*=>\s*\{\s*logger\.warn\(message,\s*metadata\)/,
  },
  {
    id: "app-logger-debug-redaction-boundary",
    file: "app/packages/utils/src/Domain/Logger/Logger.ts",
    pattern:
      /public debug[\s\S]{0,220}logWithColor\(redactLogValue\(message\) as string,\s*\.\.\.optionalParams\.map\(safeLogParameter\)\)/,
  },
  {
    id: "app-logger-info-redaction-boundary",
    file: "app/packages/utils/src/Domain/Logger/Logger.ts",
    pattern:
      /public info[\s\S]{0,220}logWithColor\(redactLogValue\(message\) as string,\s*\.\.\.optionalParams\.map\(safeLogParameter\)\)/,
  },
  {
    id: "app-logger-warn-redaction-boundary",
    file: "app/packages/utils/src/Domain/Logger/Logger.ts",
    pattern:
      /public warn[\s\S]{0,220}console\.warn\(redactLogValue\(message\),\s*\.\.\.optionalParams\.map\(safeLogParameter\)\)/,
  },
  {
    id: "app-logger-error-redaction-boundary",
    file: "app/packages/utils/src/Domain/Logger/Logger.ts",
    pattern:
      /public error[\s\S]{0,220}console\.error\(redactLogValue\(message\),\s*\.\.\.optionalParams\.map\(safeLogParameter\)\)/,
  },
  {
    id: "app-logger-error-object-projection",
    file: "app/packages/utils/src/Domain/Logger/Logger.ts",
    pattern:
      /value instanceof Error\s*\?\s*safeErrorLogMetadata\(value\)\s*:\s*redactLogValue\(value\)/,
  },
  {
    id: "app-utils-error-object-projection",
    file: "app/packages/utils/src/Domain/Utils/Utils.ts",
    pattern:
      /value instanceof Error\s*\?\s*safeErrorLogMetadata\(value\)\s*:\s*redactLogValue\(value\)/,
  },
  {
    id: "app-utils-variadic-log-redaction-boundary",
    file: "app/packages/utils/src/Domain/Utils/Utils.ts",
    pattern:
      /Function\.prototype\.apply\.call\(console\.log,\s*console,\s*args\.map\(safeUtilityLogParameter\)\)/,
  },
  {
    id: "app-snlog-message-redaction-boundary",
    file: "app/packages/snjs/lib/Log.ts",
    pattern:
      /value instanceof Error\s*\?\s*safeErrorLogMetadata\(value\)\s*:\s*redactLogValue\(value\)[\s\S]{0,220}this\.onLog\(\.\.\.message\.map\(safeSNLogValue\)\)/,
  },
  {
    id: "app-snlog-error-projection-boundary",
    file: "app/packages/snjs/lib/Log.ts",
    pattern:
      /safeErrorLogMetadata\(error\)[\s\S]{0,220}new Error\('A Standard Notes operation failed\.'\)[\s\S]{0,220}this\.onError\(safeError\)/,
  },
  {
    id: "mobile-snlog-host-log-boundary",
    file: "app/packages/mobile/index.js",
    pattern:
      /safeConsoleValue[\s\S]{0,180}safeErrorLogMetadata\(value\)[\s\S]{0,180}redactLogValue\(value\)[\s\S]{0,220}forwardSafeLog[\s\S]{0,180}messages\.map\(safeConsoleValue\)[\s\S]{0,500}SNLog\.onLog = forwardSafeLog/,
  },
  {
    id: "mobile-snlog-host-error-boundary",
    file: "app/packages/mobile/index.js",
    pattern:
      /forwardSafeError[\s\S]{0,180}safeErrorLogMetadata\(error\)[\s\S]{0,500}SNLog\.onError = forwardSafeError/,
  },
  {
    id: "mobile-console-bridge-count-projection",
    file: "app/packages/mobile/src/Lib/MobileWebViewSecurity.ts",
    pattern:
      /consoleLog\(\.\.\.args\)[\s\S]{0,180}askReactNativeToInvokeInterfaceMethod\("consoleLog",\s*\[args\.length\]\)/,
  },
  {
    id: "mobile-injected-console-safe-bridge",
    file: "app/packages/mobile/src/MobileWebAppContainer.tsx",
    pattern:
      /console\.log = \(\.\.\.args\)[\s\S]{0,160}reactNativeDevice\?\.consoleLog\(\.\.\.args\)[\s\S]{0,220}console\.error = \(\.\.\.args\)[\s\S]{0,160}reactNativeDevice\?\.consoleLog\(\.\.\.args\)/,
  },
];

function stripReviewedFunctionCalls(source, functionNames) {
  const matcher = new RegExp(`\\b(?:${functionNames.join("|")})\\s*\\(`, "g");
  let result = "";
  let cursor = 0;
  let match;

  while ((match = matcher.exec(source)) !== null) {
    result += source.slice(cursor, match.index);
    const openParenthesis = source.indexOf("(", match.index);
    let depth = 0;
    let quote;
    let escaped = false;
    let end = source.length;

    for (let index = openParenthesis; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    result += "[reviewed-safe-boundary]";
    cursor = end;
    matcher.lastIndex = end;
  }

  return result + source.slice(cursor);
}

const repositoryWideCallRules = [
  {
    id: "raw-error-detail",
    protectedOnly: true,
    matches: (call) =>
      /\b(?:err|error|exception|failure|cleanupError|rollbackError|startupError)\b[\s\S]*?\.(?:message|stack)\b/.test(
        call,
      ) || /\bString\(\s*(?:err|error|exception|failure)\s*\)/.test(call),
  },
  {
    id: "raw-error-object",
    protectedOnly: true,
    matches: (call) => {
      const withoutReviewedBoundaries = stripReviewedFunctionCalls(call, [
        "safeErrorLogMetadata",
        "safeHttpErrorLogMetadata",
        "diagnosticMessage",
        "redactSensitiveText",
        "redactForAudit",
        "boundedBootFailureText",
        // A bounded class name; its implementation is pinned in requiredRules.
        "errorName",
      ]);

      return /(?:\(|,)\s*(?:err|error|exception|failure|cleanupError|rollbackError|startupError)\s*[,)]/.test(
        withoutReviewedBoundaries,
      );
    },
  },
  {
    id: "raw-http-object",
    protectedOnly: true,
    matches: (call) => {
      const withoutReviewedBoundaries = stripReviewedFunctionCalls(call, [
        "safeHttpLogMetadata",
        "safeHttpErrorLogMetadata",
        "requestBodyLogMetadata",
      ]);

      return (
        /(?:\(|,)\s*(?:request|response|httpRequest|httpResponse)\s*[,)]/.test(
          withoutReviewedBoundaries,
        ) ||
        /\b(?:request|response|httpRequest|httpResponse)\.(?:body|data|headers|rawResponse)\s*[,)]/.test(
          withoutReviewedBoundaries,
        )
      );
    },
  },
  {
    id: "raw-serialized-object",
    protectedOnly: true,
    matches: (call) =>
      /JSON\.stringify\(\s*(?:dto|event|message|payload|request|response|session|user)\b/.test(
        call,
      ),
  },
  {
    id: "raw-sensitive-interpolation",
    matches: (call) =>
      /\$\{[^}]*(?:email|password|passcode|credential|secret|sessionKey|sessionUuid|userAgent|(?:auth|access|refresh|offline|subscription)?Token)[^}]*\}/i.test(
        call,
      ),
  },
  {
    id: "pii-mislabeled-as-user-id",
    matches: (call) =>
      /\buser(?:Id|Uuid)\s*:\s*[^,}\n]*(?:email|username)/i.test(call),
  },
  {
    id: "raw-domain-result-error",
    protectedOnly: true,
    matches: (call) =>
      /\.getError\(\)/.test(
        stripReviewedFunctionCalls(call, [
          "safeErrorLogMetadata",
          "safeHttpErrorLogMetadata",
          // Reduces a Result error to a constant string or a fixed placeholder,
          // so an inline boot refusal carries no path, URL or configured value.
          "boundedBootFailureText",
        ]),
      ),
  },
  {
    id: "dynamic-error-message",
    protectedOnly: true,
    matches: (call) => {
      const usesDynamicMessage =
        /\.(?:error|warn)\(\s*(?:message|errorMessage|reason)\s*[,)]/.test(
          call,
        );
      const forwardsReviewedMetadata =
        /\.(?:error|warn)\(\s*(?:message|errorMessage|reason)\s*,\s*metadata\s*\)/.test(
          call,
        );

      return usesDynamicMessage && !forwardsReviewedMetadata;
    },
  },
  {
    id: "raw-app-error-alias",
    appOnly: true,
    matches: (call) => {
      const withoutReviewedBoundaries = stripReviewedFunctionCalls(call, [
        "safeErrorLogMetadata",
        "safeHttpErrorLogMetadata",
        "redactLogValue",
      ]);

      return (
        /\be\b[\s\S]*?\.(?:message|stack)\b/.test(withoutReviewedBoundaries) ||
        /\bString\(\s*e\s*\)/.test(withoutReviewedBoundaries) ||
        /(?:\(|,)\s*e\s*[,)]/.test(withoutReviewedBoundaries)
      );
    },
  },
  {
    id: "raw-app-domain-object",
    appOnly: true,
    matches: (call) => {
      const withoutReviewedBoundaries = stripReviewedFunctionCalls(call, [
        "safeErrorLogMetadata",
        "safeHttpErrorLogMetadata",
        "safeHttpLogMetadata",
        "redactLogValue",
      ]);

      return /(?:\(|,)\s*(?:apply|args|arguments|event|message|options|payloads?|requiredPermissions|syncToken|paginationToken|cursorToken)\s*[,)]/.test(
        withoutReviewedBoundaries,
      );
    },
  },
];

const repositoryWideSourceRules = [
  {
    id: "direct-console-callback",
    protectedOnly: true,
    pattern: /\.catch\(\s*console\.(?:error|warn|log)\s*\)/g,
  },
  {
    id: "subscription-credential-in-url",
    pattern:
      /(?:subscription-?tokens?|offline\/subscription-?tokens?)[^'"`\n]*\$\{[^}]*(?:token|credential)[^}]*\}/gi,
  },
  {
    id: "raw-telemetry-exception",
    protectedOnly: true,
    pattern:
      /\.recordException\(\s*(?:err|error|exception|failure|cleanupError|rollbackError|startupError)\s*\)/g,
  },
];

function offsetToLine(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

// The whole call that starts at each match of `callStart`, from the match to
// the parenthesis that closes its argument list, skipping string contents.
function extractCalls(source, callStart) {
  const calls = [];
  let match;
  callStart.lastIndex = 0;

  while ((match = callStart.exec(source)) !== null) {
    const openParenthesis = source.indexOf("(", match.index);
    let depth = 0;
    let quote;
    let escaped = false;
    let end = source.length;

    for (let index = openParenthesis; index < source.length; index += 1) {
      const character = source[index];

      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    calls.push({
      call: source.slice(match.index, end),
      args: source.slice(openParenthesis + 1, end - 1),
      line: offsetToLine(source, match.index),
    });
    callStart.lastIndex = end;
  }

  return calls;
}

// A receiver or a method reached through optional chaining is the same call:
// `logger?.info(`, `this.logger?.error(`, `deps?.logger.warn(`. Until this
// pattern allowed the `?`, every such call was invisible to the rules below.
const logCallStart =
  /\b(?:console|(?:[A-Za-z_$][\w$]*\??\.)*(?:logger|[A-Za-z_$][\w$]*Logger))\??\.(?:debug|error|info|log|warn)\s*\(/g;

function extractLogCalls(source) {
  return extractCalls(source, logCallStart);
}

/**
 * A function that takes the log message as its own parameter and hands it on
 * is not logging a dynamic message, as long as every caller passes a string
 * literal. Each such wrapper is declared here with its exact forwarding call
 * and with how it is invoked. The validator then reads the callers instead of
 * taking the declaration on trust: an invocation whose message is not a
 * literal fails, every invocation is held to the content rules a log call is
 * held to, and a declaration that no longer matches the code fails as stale.
 */
export const messageForwardingWrappers = Object.freeze([
  {
    file: "server/packages/websocket-gateway/src/gateway.ts",
    forwards:
      "logger.warn(message, JSON.stringify({ ...(metadata ?? {}), suppressedSinceLastLog: decision.suppressed }))",
    invocations: [
      {
        file: "server/packages/websocket-gateway/src/gateway.ts",
        pattern: /\blogRefusal\(/g,
      },
      {
        file: "server/packages/websocket-gateway/src/syncCommandHandler.ts",
        pattern: /\blogRefusal\?\.\(/g,
      },
    ],
  },
  {
    file: "server/packages/auth/src/Domain/Invite/InviteEventOutboxDispatcher.ts",
    forwards: "this.logger?.error(message, safeErrorLogMetadata(error))",
    invocations: [
      {
        file: "server/packages/auth/src/Domain/Invite/InviteEventOutboxDispatcher.ts",
        pattern: /\bthis\.report\(/g,
      },
    ],
  },
]);

// An error handed to a wrapper is the wrapper's to project, and its own log
// call is checked for that; the message is checked as a literal instead.
const rulesNotAppliedToWrapperInvocations = new Set([
  "raw-error-object",
  "dynamic-error-message",
]);

function normalizeCall(call) {
  return call.replace(/\s+/g, " ").trim();
}

const singleQuotedLiteral = /'(?:[^'\\\n]|\\.)*'/;
const doubleQuotedLiteral = /"(?:[^"\\\n]|\\.)*"/;
const plainTemplateLiteral = /`(?:[^`\\$]|\\.|\$(?!\{))*`/;
const anyStringLiteral = `(?:${singleQuotedLiteral.source}|${doubleQuotedLiteral.source}|${plainTemplateLiteral.source})`;
const stringLiteralPattern = new RegExp(`^${anyStringLiteral}$`);
// `condition ? 'one literal' : 'another'`: either way the message is a literal.
// The condition may hold no quote, so it cannot carry a string of its own.
const conditionalBetweenLiteralsPattern = new RegExp(
  `^[^'"\`?:]+\\?\\s*${anyStringLiteral}\\s*:\\s*${anyStringLiteral}$`,
);

function isStringLiteral(text) {
  return stringLiteralPattern.test(text);
}

function isLiteralMessage(text) {
  return isStringLiteral(text) || conditionalBetweenLiteralsPattern.test(text);
}

function ruleAppliesTo(rule, file) {
  if (rule.protectedOnly && !isProtectedLoggingSource(file)) {
    return false;
  }
  return !rule.appOnly || isGuardedAppLoggingSource(file);
}

function findForwardingWrapperFindings(sources, wrappers) {
  const findings = [];

  for (const wrapper of wrappers) {
    const source = sources[wrapper.file];
    if (source === undefined) {
      continue;
    }

    const forwarding = extractLogCalls(source).find(
      ({ call }) => normalizeCall(call) === wrapper.forwards,
    );
    if (forwarding === undefined) {
      findings.push({
        file: wrapper.file,
        line: 1,
        rule: "stale-forwarding-wrapper",
        source: wrapper.forwards,
      });
    }

    let invocationCount = 0;
    for (const { file, pattern } of wrapper.invocations) {
      const invoking = sources[file];
      if (invoking === undefined) {
        findings.push({
          file,
          line: 1,
          rule: "forwarding-wrapper-caller-not-checked",
          source: wrapper.forwards,
        });
        continue;
      }

      for (const { call, args, line } of extractCalls(invoking, pattern)) {
        invocationCount += 1;
        if (!isLiteralMessage((splitTopLevel(args)[0] ?? "").trim())) {
          findings.push({
            file,
            line,
            rule: "forwarded-message-not-literal",
            source: call,
          });
        }
        for (const rule of repositoryWideCallRules) {
          if (
            !rulesNotAppliedToWrapperInvocations.has(rule.id) &&
            ruleAppliesTo(rule, file) &&
            rule.matches(call, file)
          ) {
            findings.push({ file, line, rule: rule.id, source: call });
          }
        }
      }
    }

    if (invocationCount === 0) {
      findings.push({
        file: wrapper.file,
        line: forwarding?.line ?? 1,
        rule: "forwarding-wrapper-never-invoked",
        source: wrapper.forwards,
      });
    }
  }

  return findings;
}

export function findRepositoryWideFindings(
  sources,
  wrappers = messageForwardingWrappers,
) {
  const findings = [];

  for (const [file, source] of Object.entries(sources)) {
    const forwardingCalls = new Set(
      wrappers
        .filter((wrapper) => wrapper.file === file)
        .map((wrapper) => wrapper.forwards),
    );

    for (const { call, line } of extractLogCalls(source)) {
      for (const rule of repositoryWideCallRules) {
        if (!ruleAppliesTo(rule, file)) {
          continue;
        }
        if (
          rule.id === "dynamic-error-message" &&
          forwardingCalls.has(normalizeCall(call))
        ) {
          continue;
        }
        if (rule.matches(call, file)) {
          findings.push({ file, line, rule: rule.id, source: call });
        }
      }
    }

    for (const rule of repositoryWideSourceRules) {
      if (!ruleAppliesTo(rule, file)) {
        continue;
      }
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source)) !== null) {
        findings.push({
          file,
          line: offsetToLine(source, match.index),
          rule: rule.id,
          source: match[0],
        });
      }
    }
  }

  findings.push(...findForwardingWrapperFindings(sources, wrappers));

  return findings;
}

function applyReviewedAllowlist(findings, allowlist) {
  const unmatchedAllowlistEntries = new Set(allowlist);
  const failures = [];
  const allowedFindings = [];

  for (const finding of findings) {
    const entry = allowlist.find(
      (candidate) =>
        candidate.file === finding.file &&
        candidate.line === finding.line &&
        candidate.rule === finding.rule &&
        candidate.call === finding.source,
    );

    if (entry === undefined) {
      failures.push(
        `${finding.file}:${finding.line}: unreviewed repository-wide finding ${finding.rule}`,
      );
      continue;
    }

    unmatchedAllowlistEntries.delete(entry);
    allowedFindings.push({ ...finding, reason: entry.reason });
  }

  for (const entry of unmatchedAllowlistEntries) {
    failures.push(
      `${entry.file}:${entry.line}: stale safe-logging allowlist entry ${entry.rule}`,
    );
  }

  return { allowedFindings, failures };
}

/**
 * The DAV bridge (server/packages/api-gateway/src/Service/DavBridge) makes this
 * server open connections to addresses users typed, carrying passwords it
 * stores for them. Its logging is held to a stricter contract than the
 * repository-wide rules above, because here the dangerous values are not only
 * errors and tokens: a request PATH names a user and a calendar, a HOST names
 * something on somebody's network, and anything the remote server sent is
 * attacker-controlled text.
 *
 *   1. Every log call in the bridge has a fixed, literal message and metadata
 *      that is an object literal whose keys come from the closed list below.
 *      No spread, no computed key, no variable handed over whole.
 *   2. No metadata VALUE refers to a path, an address, a header, a body, a
 *      username, a secret or an error's text.
 *   3. The stored secret is revealed at an audited, counted set of call sites
 *      and nowhere else in the api-gateway.
 *   4. The rules above are checked against something: a minimum number of log
 *      calls must be found, and the two per-request lines must be among them.
 *      A contract that matched no call would pass for ever.
 *
 * Optional chaining (`logger?.info(`) is recognised here, as it is by the
 * repository-wide extractor above.
 */
export const davBridgeLoggingPrefixes = Object.freeze([
  "server/packages/api-gateway/src/Service/DavBridge/",
  "server/packages/api-gateway/src/Controller/v1/DavBridgeController.ts",
]);

export const davBridgeAllowedLogFields = Object.freeze([
  "userId",
  "accountId",
  "method",
  "status",
  "durationMs",
  "requestBytes",
  "responseBytes",
  "tag",
  "reason",
  "accounts",
  "errorType",
  "ignored",
  // Administrator audit lines: setting NAMES and counts, never values.
  "audit",
  "adminUuid",
  "changedSettings",
  "scope",
  "purgedUsers",
  "purgedAccounts",
]);

/** file -> exact number of `.reveal()` calls. Everything else in the api-gateway must have none. */
export const davBridgeSecretRevealSites = Object.freeze({
  // The Authorization header: once for a bearer token, once for Basic.
  "server/packages/api-gateway/src/Service/DavBridge/DavRelay.ts": 2,
  // Sealing the secret for storage.
  "server/packages/api-gateway/src/Service/DavBridge/DavSecretCipher.ts": 1,
});

export const davBridgeRequiredLogMessages = Object.freeze([
  "dav bridge request relayed",
  "dav bridge request refused",
]);

export const davBridgeMinimumLogCalls = 8;

const davBridgeForbiddenValueWords =
  /\b(?:path|paths|pathname|url|href|origin|host|hostname|address|headers?|body|username|secret|password|authorization|location|message|stack|envelope|entryPath|principalPath|calendarHomePath|reveal)\b/;

function isDavBridgeLoggingSource(file) {
  return davBridgeLoggingPrefixes.some(
    (prefix) => file === prefix || file.startsWith(prefix),
  );
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function extractDavBridgeLogCalls(source) {
  const calls = [];
  const callStart =
    /\b(?:console|(?:[A-Za-z_$][\w$]*\??\.)*(?:logger|[A-Za-z_$][\w$]*Logger))\??\.(?:debug|error|info|log|warn)\s*\(/g;
  let match;
  while ((match = callStart.exec(source)) !== null) {
    const openParenthesis = source.indexOf("(", match.index);
    let depth = 0;
    let quote;
    let escaped = false;
    let end = source.length;
    for (let index = openParenthesis; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    calls.push({
      head: source.slice(match.index, openParenthesis),
      args: source.slice(openParenthesis + 1, end - 1),
      line: offsetToLine(source, match.index),
    });
    callStart.lastIndex = end;
  }
  return calls;
}

export function validateDavBridgeLogging(sources) {
  const failures = [];
  const allowedFields = new Set(davBridgeAllowedLogFields);
  const messages = [];
  let callCount = 0;

  for (const [file, source] of Object.entries(sources)) {
    if (source === undefined) {
      continue;
    }

    if (file.startsWith("server/packages/api-gateway/")) {
      const reveals = (source.match(/\.reveal\(\)/g) ?? []).length;
      const expected = davBridgeSecretRevealSites[file] ?? 0;
      if (reveals !== expected) {
        failures.push(
          `${file}: the stored DAV account secret is revealed ${reveals} time(s) here; the audited number for this file is ${expected}`,
        );
      }
    }

    if (!isDavBridgeLoggingSource(file)) {
      continue;
    }

    for (const { head, args, line } of extractDavBridgeLogCalls(source)) {
      callCount += 1;
      if (head.startsWith("console")) {
        failures.push(`${file}:${line}: the DAV bridge must not log through console`);
        continue;
      }

      const parts = splitTopLevel(args);
      const message = parts[0] ?? "";
      const literal = /^'([^'\\$]*)'$/.exec(message);
      if (literal === null) {
        failures.push(
          `${file}:${line}: a DAV bridge log message must be a fixed single-quoted literal`,
        );
      } else {
        messages.push(literal[1]);
      }

      if (parts.length > 2) {
        failures.push(`${file}:${line}: a DAV bridge log call takes a message and one metadata object`);
      }
      if (parts.length < 2) {
        continue;
      }

      const metadata = parts[1];
      if (!metadata.startsWith("{") || !metadata.endsWith("}")) {
        failures.push(
          `${file}:${line}: DAV bridge log metadata must be an object literal written at the call`,
        );
        continue;
      }
      for (const property of splitTopLevel(metadata.slice(1, -1))) {
        if (property.startsWith("...")) {
          failures.push(`${file}:${line}: DAV bridge log metadata must not spread an object`);
          continue;
        }
        const colon = property.indexOf(":");
        const key = (colon < 0 ? property : property.slice(0, colon)).trim();
        const value = colon < 0 ? property : property.slice(colon + 1).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
          failures.push(`${file}:${line}: DAV bridge log metadata has a key that is not a plain name`);
          continue;
        }
        if (!allowedFields.has(key)) {
          failures.push(`${file}:${line}: DAV bridge log field "${key}" is not on the closed list`);
        }
        if (davBridgeForbiddenValueWords.test(value)) {
          failures.push(
            `${file}:${line}: DAV bridge log field "${key}" is built from a path, address, header, body, name, secret or error text`,
          );
        }
      }
    }
  }

  const bridgeFilesProvided = Object.keys(sources).some(isDavBridgeLoggingSource);
  if (bridgeFilesProvided) {
    if (callCount < davBridgeMinimumLogCalls) {
      failures.push(
        `DAV bridge logging contract found ${callCount} log call(s); at least ${davBridgeMinimumLogCalls} are expected, so the contract is not looking at the code it describes`,
      );
    }
    for (const required of davBridgeRequiredLogMessages) {
      if (!messages.includes(required)) {
        failures.push(`DAV bridge logging contract did not find the "${required}" line`);
      }
    }
    for (const file of Object.keys(davBridgeSecretRevealSites)) {
      if (sources[file] === undefined) {
        failures.push(`${file}: an audited secret-reveal site was not among the sources checked`);
      }
    }
  }

  return failures;
}

export async function discoverLiveSourceFiles(root) {
  const discovered = [];

  async function visit(absoluteDirectory) {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredPathSegments.has(entry.name)) {
        continue;
      }

      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !liveSourceExtensions.has(extname(entry.name))) {
        continue;
      }

      const repositoryPath = relative(root, absolutePath).replaceAll("\\", "/");
      if (!ignoredFilePattern.test(repositoryPath)) {
        discovered.push(repositoryPath);
      }
    }
  }

  await Promise.all(
    guardedRuntimeRoots.map((sourceRoot) => visit(resolve(root, sourceRoot))),
  );

  return discovered.sort();
}

export function validateSafeLoggingSources(sources, options = {}) {
  const failures = [];
  const forbidden = options.forbiddenRules ?? forbiddenRules;
  const required = options.requiredRules ?? requiredRules;

  for (const [file, source] of Object.entries(sources)) {
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) {
        failures.push(`${file}: forbidden pattern ${rule.id}`);
      }
    }
  }

  for (const rule of required) {
    const source = sources[rule.file];
    if (source === undefined || !rule.pattern.test(source)) {
      failures.push(`${rule.file}: missing required contract ${rule.id}`);
    }
  }

  const helperSources = safeLogHelperFiles
    .map((file) => [file, sources[file]])
    .filter((entry) => entry[1] !== undefined);
  if (helperSources.length > 0) {
    if (helperSources.length !== safeLogHelperFiles.length) {
      failures.push(
        "safe-log helper parity: not every helper source was provided",
      );
    } else {
      const kernels = helperSources.map(([file, source]) => {
        const start = source.indexOf(safeLogKernelStart);
        const end = source.indexOf(safeLogKernelEnd);
        if (start < 0 || end < start) {
          failures.push(`${file}: missing safe-log shared-kernel markers`);
          return [file, undefined];
        }
        return [file, source.slice(start, end + safeLogKernelEnd.length)];
      });
      const baseline = kernels[0]?.[1];
      for (const [file, kernel] of kernels.slice(1)) {
        if (
          kernel !== undefined &&
          baseline !== undefined &&
          kernel !== baseline
        ) {
          failures.push(
            `${file}: safe-log shared kernel differs from ${kernels[0][0]}`,
          );
        }
      }
    }
  }

  return failures;
}

export function validateRepositoryWideSafeLoggingSources(
  sources,
  allowlist = reviewedSafeLoggingAllowlist,
) {
  return applyReviewedAllowlist(findRepositoryWideFindings(sources), allowlist);
}

const execFileAsync = promisify(execFile);

/**
 * The paths git tracks under the guarded roots, or undefined when `root` is
 * not a git work tree. A CI checkout contains only tracked files, so there
 * this changes nothing; in a shared working tree it keeps somebody else's
 * uncommitted scratch file from failing a gate that is about the repository.
 * A file staged with `git add -N` is tracked and is checked.
 */
export async function listTrackedFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--", ...guardedRuntimeRoots],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 },
    );
    return new Set(stdout.split("\0").filter((file) => file.length > 0));
  } catch {
    return undefined;
  }
}

export async function validateSafeLogging(root = repositoryRoot) {
  const discoveredFiles = await discoverLiveSourceFiles(root);
  const tracked = await listTrackedFiles(root);
  const liveSourceFiles =
    tracked === undefined
      ? discoveredFiles
      : discoveredFiles.filter((file) => tracked.has(file));
  const filesToRead = [
    ...new Set([...liveSourceFiles, ...contractSourceFiles]),
  ];
  const sources = Object.fromEntries(
    await Promise.all(
      filesToRead.map(async (file) => {
        return [file, await readFile(resolve(root, file), "utf8")];
      }),
    ),
  );
  const contractSources = Object.fromEntries(
    contractSourceFiles.map((file) => [file, sources[file]]),
  );
  const failures = validateSafeLoggingSources(contractSources);
  const repositoryWideResult =
    validateRepositoryWideSafeLoggingSources(sources);
  failures.push(...repositoryWideResult.failures);
  failures.push(...validateDavBridgeLogging(sources));

  if (failures.length > 0) {
    throw new Error(
      `Safe logging validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }

  return {
    allowedFindings: repositoryWideResult.allowedFindings,
    sourceFileCount: liveSourceFiles.length,
    untrackedSkippedCount: discoveredFiles.length - liveSourceFiles.length,
  };
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  const result = await validateSafeLogging();
  process.stdout.write(
    `Safe logging validation passed (${result.sourceFileCount} live source files; ${result.allowedFindings.length} reviewed residuals; ${result.untrackedSkippedCount} untracked files not checked).\n`,
  );
  if (process.argv.includes("--report-allowlist")) {
    for (const finding of result.allowedFindings) {
      process.stdout.write(
        `- ${finding.file}:${finding.line} [${finding.rule}] ${finding.reason}\n`,
      );
    }
  }
}
