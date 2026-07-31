import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "server/packages/api-gateway/src/Controller/WebSocketAuthMiddleware.ts",
  "server/packages/api-gateway/src/Controller/SubscriptionTokenAuthMiddleware.ts",
  "server/packages/api-gateway/src/Controller/RateLimitMiddleware.ts",
  "server/packages/api-gateway/src/Controller/UserRateLimitMiddleware.ts",
  "server/packages/api-gateway/src/Controller/v1/CollaborationController.ts",
  "server/packages/api-gateway/bin/server.ts",
  "server/packages/api-gateway/src/Service/Http/HttpServiceProxy.ts",
  "server/packages/api-gateway/src/Service/gRPC/GRPCServiceProxy.ts",
  "server/packages/api-gateway/src/Service/gRPC/GRPCSyncingServerServiceProxy.ts",
  "server/packages/websocket-gateway/src/index.ts",
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
export const reviewedSafeLoggingAllowlist = [];

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

const requiredRules = [
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
  {
    id: "standalone-websocket-info-boundary",
    file: "server/packages/websocket-gateway/src/index.ts",
    pattern: /console\.log\([^;\n]*\.\.\.safeLogArguments\(args\)\)/,
  },
  {
    id: "standalone-websocket-warn-boundary",
    file: "server/packages/websocket-gateway/src/index.ts",
    pattern: /console\.warn\([^;\n]*\.\.\.safeLogArguments\(args\)\)/,
  },
  {
    id: "standalone-websocket-error-boundary",
    file: "server/packages/websocket-gateway/src/index.ts",
    pattern: /console\.error\([^;\n]*\.\.\.safeLogArguments\(args\)\)/,
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

function extractLogCalls(source) {
  const calls = [];
  const callStart =
    /\b(?:console|(?:[A-Za-z_$][\w$]*\.)*(?:logger|[A-Za-z_$][\w$]*Logger))\.(?:debug|error|info|log|warn)\s*\(/g;
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
      call: source.slice(match.index, end),
      line: offsetToLine(source, match.index),
    });
    callStart.lastIndex = end;
  }

  return calls;
}

export function findRepositoryWideFindings(sources) {
  const findings = [];

  for (const [file, source] of Object.entries(sources)) {
    for (const { call, line } of extractLogCalls(source)) {
      for (const rule of repositoryWideCallRules) {
        if (rule.protectedOnly && !isProtectedLoggingSource(file)) {
          continue;
        }
        if (rule.appOnly && !isGuardedAppLoggingSource(file)) {
          continue;
        }
        if (rule.matches(call, file)) {
          findings.push({ file, line, rule: rule.id, source: call });
        }
      }
    }

    for (const rule of repositoryWideSourceRules) {
      if (rule.protectedOnly && !isProtectedLoggingSource(file)) {
        continue;
      }
      if (rule.appOnly && !isGuardedAppLoggingSource(file)) {
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

export async function validateSafeLogging(root = repositoryRoot) {
  const liveSourceFiles = await discoverLiveSourceFiles(root);
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

  if (failures.length > 0) {
    throw new Error(
      `Safe logging validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }

  return {
    allowedFindings: repositoryWideResult.allowedFindings,
    sourceFileCount: liveSourceFiles.length,
  };
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  const result = await validateSafeLogging();
  process.stdout.write(
    `Safe logging validation passed (${result.sourceFileCount} live source files; ${result.allowedFindings.length} reviewed residuals).\n`,
  );
  if (process.argv.includes("--report-allowlist")) {
    for (const finding of result.allowedFindings) {
      process.stdout.write(
        `- ${finding.file}:${finding.line} [${finding.rule}] ${finding.reason}\n`,
      );
    }
  }
}
