// AWS Bedrock provider — SCAFFOLD ONLY.
//
// TODO: SigV4 signing. Bedrock's InvokeModelWithResponseStream endpoint requires
// every request to be signed with AWS Signature Version 4 (access key / secret /
// region / service scope). That signer is intentionally NOT implemented here to
// avoid shipping a broken half-stream; wire it in a dedicated follow-up. Until
// then send() fails soft with a clear, actionable error.

import { Provider, ProviderRequest, ProviderEvent } from './types'

export interface BedrockConfig {
  /** True only when ASSISTANT_BEDROCK_ENABLED === 'true'. */
  enabled: boolean
  /** AWS region hosting the Bedrock runtime (e.g. us-east-1). */
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** Optional override for the Bedrock runtime base URL. */
  baseURL?: string
}

/**
 * Bedrock is considered configured only when explicitly enabled via
 * ASSISTANT_BEDROCK_ENABLED. Even when enabled, requests currently fail soft
 * because SigV4 signing is not yet implemented (see TODO above).
 */
export function bedrockConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ASSISTANT_BEDROCK_ENABLED === 'true'
}

/** Reads the Bedrock configuration from the environment. Never returns secrets to callers. */
export function resolveBedrockConfig(env: NodeJS.ProcessEnv = process.env): BedrockConfig {
  return {
    enabled: bedrockConfigured(env),
    region: env.ASSISTANT_BEDROCK_REGION,
    accessKeyId: env.ASSISTANT_BEDROCK_ACCESS_KEY_ID,
    secretAccessKey: env.ASSISTANT_BEDROCK_SECRET_ACCESS_KEY,
    sessionToken: env.ASSISTANT_BEDROCK_SESSION_TOKEN,
    baseURL: env.ASSISTANT_BEDROCK_BASE_URL,
  }
}

/**
 * Scaffold provider. Yields a single, clear error event followed by a finish so
 * the streaming proxy degrades gracefully instead of half-implementing signing.
 */
export class BedrockProvider implements Provider {
  readonly id = 'bedrock'

  constructor(
    private readonly model: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    void this.model
    void env
  }

  async *send(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    yield {
      kind: 'error',
      message: 'AWS Bedrock requires SigV4 request signing which is not yet implemented; configure a follow-up.',
    }
    yield { kind: 'finish', stopReason: 'error' }
  }
}
