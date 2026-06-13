import type { Provider } from "./types.js";
import type { ProviderConfig } from "../config/schema.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { HermesProvider } from "./hermes/index.js";
import { MockProvider } from "./mock.js";

export function resolveProvider(cfg: ProviderConfig): Provider {
  switch (cfg.type) {
    case "anthropic":
      return new AnthropicProvider(cfg.model, cfg.base_url);
    case "openai":
      return new OpenAIProvider(cfg.model, cfg.base_url);
    case "ollama":
      return new OllamaProvider(cfg.model, cfg.base_url);
    case "hermes":
      return new HermesProvider(
        cfg.model,
        cfg.base_url,
        cfg.transport,
        cfg.api_key_env ? process.env[cfg.api_key_env] : undefined,
      );
    case "mock":
      return new MockProvider([]);
  }
}
