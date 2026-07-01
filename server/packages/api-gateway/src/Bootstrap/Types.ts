export const TYPES = {
  ApiGateway_Logger: Symbol.for('ApiGateway_Logger'),
  ApiGateway_Redis: Symbol.for('ApiGateway_Redis'),
  ApiGateway_HTTPClient: Symbol.for('ApiGateway_HTTPClient'),
  ApiGateway_SNS: Symbol.for('ApiGateway_SNS'),
  ApiGateway_DomainEventPublisher: Symbol.for('ApiGateway_DomainEventPublisher'),
  // env vars
  ApiGateway_CORS_ALLOWED_ORIGINS: Symbol.for('ApiGateway_CORS_ALLOWED_ORIGINS'),
  ApiGateway_SNS_TOPIC_ARN: Symbol.for('ApiGateway_SNS_TOPIC_ARN'),
  ApiGateway_SNS_AWS_REGION: Symbol.for('ApiGateway_SNS_AWS_REGION'),
  ApiGateway_SYNCING_SERVER_JS_URL: Symbol.for('ApiGateway_SYNCING_SERVER_JS_URL'),
  ApiGateway_AUTH_SERVER_URL: Symbol.for('ApiGateway_AUTH_SERVER_URL'),
  ApiGateway_AUTH_SERVER_GRPC_URL: Symbol.for('ApiGateway_AUTH_SERVER_GRPC_URL'),
  ApiGateway_SYNCING_SERVER_GRPC_URL: Symbol.for('ApiGateway_SYNCING_SERVER_GRPC_URL'),
  ApiGateway_PAYMENTS_SERVER_URL: Symbol.for('ApiGateway_PAYMENTS_SERVER_URL'),
  ApiGateway_FILES_SERVER_URL: Symbol.for('ApiGateway_FILES_SERVER_URL'),
  ApiGateway_REVISIONS_SERVER_URL: Symbol.for('ApiGateway_REVISIONS_SERVER_URL'),
  ApiGateway_EMAIL_SERVER_URL: Symbol.for('ApiGateway_EMAIL_SERVER_URL'),
  ApiGateway_WEB_SOCKET_SERVER_URL: Symbol.for('ApiGateway_WEB_SOCKET_SERVER_URL'),
  ApiGateway_AUTH_JWT_SECRET: Symbol.for('ApiGateway_AUTH_JWT_SECRET'),
  // Standard Red Notes: secret + TTL used to mint short-lived collaboration-room
  // capabilities (same HS256 secret the websocket-gateway verifies connection
  // tokens with, so the gateway can verify a capability locally).
  ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET: Symbol.for('ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET'),
  ApiGateway_COLLABORATION_CAPABILITY_TTL: Symbol.for('ApiGateway_COLLABORATION_CAPABILITY_TTL'),
  ApiGateway_HTTP_CALL_TIMEOUT: Symbol.for('ApiGateway_HTTP_CALL_TIMEOUT'),
  ApiGateway_VERSION: Symbol.for('ApiGateway_VERSION'),
  ApiGateway_CROSS_SERVICE_TOKEN_CACHE_TTL: Symbol.for('ApiGateway_CROSS_SERVICE_TOKEN_CACHE_TTL'),
  ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER: Symbol.for('ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER'),
  ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER_OR_SELF_HOSTING: Symbol.for(
    'ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER_OR_SELF_HOSTING',
  ),
  ApiGateway_CAPTCHA_UI_URL: Symbol.for('ApiGateway_CAPTCHA_UI_URL'),
  ApiGateway_ASSISTANT_PROVIDER_CONFIG: Symbol.for('ApiGateway_ASSISTANT_PROVIDER_CONFIG'),
  ApiGateway_ASSISTANT_DEFAULT_PROVIDER: Symbol.for('ApiGateway_ASSISTANT_DEFAULT_PROVIDER'),
  ApiGateway_ASSISTANT_DEFAULT_MODEL: Symbol.for('ApiGateway_ASSISTANT_DEFAULT_MODEL'),
  ApiGateway_ASSISTANT_DAILY_REQUEST_LIMIT: Symbol.for('ApiGateway_ASSISTANT_DAILY_REQUEST_LIMIT'),
  // Standard Red Notes: operator-configured list of speech-to-text (STT) model ids
  // advertised to clients for the audio-recorder transcription model picker.
  ApiGateway_ASSISTANT_TRANSCRIPTION_MODELS: Symbol.for('ApiGateway_ASSISTANT_TRANSCRIPTION_MODELS'),
  // Standard Red Notes: opt-in server-side PDF OCR (tesseract-in-Node).
  ApiGateway_OCR_SERVER_ENABLED: Symbol.for('ApiGateway_OCR_SERVER_ENABLED'),
  ApiGateway_OCR_DEFAULT_LANGUAGE: Symbol.for('ApiGateway_OCR_DEFAULT_LANGUAGE'),
  ApiGateway_OCR_MAX_PAGES: Symbol.for('ApiGateway_OCR_MAX_PAGES'),
  ApiGateway_OCR_MAX_IMAGE_BYTES: Symbol.for('ApiGateway_OCR_MAX_IMAGE_BYTES'),
  ApiGateway_OcrService: Symbol.for('ApiGateway_OcrService'),
  // Middleware
  ApiGateway_RequiredCrossServiceTokenMiddleware: Symbol.for('ApiGateway_RequiredCrossServiceTokenMiddleware'),
  ApiGateway_OptionalCrossServiceTokenMiddleware: Symbol.for('ApiGateway_OptionalCrossServiceTokenMiddleware'),
  ApiGateway_WebSocketAuthMiddleware: Symbol.for('ApiGateway_WebSocketAuthMiddleware'),
  ApiGateway_SubscriptionTokenAuthMiddleware: Symbol.for('ApiGateway_SubscriptionTokenAuthMiddleware'),
  // Mapping
  Mapper_SyncRequestGRPCMapper: Symbol.for('Mapper_SyncRequestGRPCMapper'),
  Mapper_SyncResponseGRPCMapper: Symbol.for('Mapper_SyncResponseGRPCMapper'),
  // Services
  ApiGateway_DomainEventFactory: Symbol.for('ApiGateway_DomainEventFactory'),
  ApiGateway_GRPCSyncingServerServiceProxy: Symbol.for('ApiGateway_GRPCSyncingServerServiceProxy'),
  ApiGateway_ServiceProxy: Symbol.for('ApiGateway_ServiceProxy'),
  ApiGateway_CrossServiceTokenCache: Symbol.for('ApiGateway_CrossServiceTokenCache'),
  ApiGateway_Timer: Symbol.for('ApiGateway_Timer'),
  ApiGateway_EndpointResolver: Symbol.for('ApiGateway_EndpointResolver'),
  ApiGateway_GRPCAuthClient: Symbol.for('ApiGateway_GRPCAuthClient'),
  ApiGateway_GRPCSyncingClient: Symbol.for('ApiGateway_GRPCSyncingClient'),
  // Standard Red Notes: optional server-mediated "Publish note to GitHub" use-case.
  ApiGateway_GitHubPublishService: Symbol.for('ApiGateway_GitHubPublishService'),
  // Standard Red Notes: server-side WEB proxy (fetch + search) for the browser AI agent.
  ApiGateway_WebService: Symbol.for('ApiGateway_WebService'),
  // Standard Red Notes: read-only CalDAV feed of EXPLICITLY published reminders.
  ApiGateway_CALDAV_ENABLED: Symbol.for('ApiGateway_CALDAV_ENABLED'),
  ApiGateway_CALDAV_BASE_PATH: Symbol.for('ApiGateway_CALDAV_BASE_PATH'),
  ApiGateway_CaldavService: Symbol.for('ApiGateway_CaldavService'),
  // Standard Red Notes: server-side reminder DELIVERY of EXPLICITLY published reminders.
  ApiGateway_REMINDER_DELIVERY_ENABLED: Symbol.for('ApiGateway_REMINDER_DELIVERY_ENABLED'),
  ApiGateway_ReminderDeliveryService: Symbol.for('ApiGateway_ReminderDeliveryService'),
  ApiGateway_ReminderDeliveryScheduler: Symbol.for('ApiGateway_ReminderDeliveryScheduler'),
}
