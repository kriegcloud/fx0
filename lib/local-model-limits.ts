// CLIProxyAPI 8.0.47-dankstation.1, internal/registry/models/models.json,
// verified against the installed service's source receipt on 2026-10-29.
// These are the proxy route's declared limits, not proof of account access.
// libfx omits max_tokens when maxOutputTokens is unknown and rejects image
// prompts when supportsVision is absent. Vision follows supportedInputModalities
// in that same catalog; the original K2 and K2 Thinking are text-only.
export const KIMI_MODEL_LIMITS = {
  'kimi-k2': { contextWindow: 131072, maxOutputTokens: 32768, supportsVision: false },
  'kimi-k2-thinking': { contextWindow: 131072, maxOutputTokens: 32768, supportsVision: false },
  'kimi-k2.5': { contextWindow: 262144, maxOutputTokens: 32768, supportsVision: true },
  'kimi-k2.6': { contextWindow: 262144, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k2.7-code': { contextWindow: 262144, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k2.7-code-highspeed': { contextWindow: 262144, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k2.8': { contextWindow: 1048576, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k2.8-code': { contextWindow: 1048576, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k3': { contextWindow: 1048576, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k3-256k': { contextWindow: 262144, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k3.1-pro': { contextWindow: 1048576, maxOutputTokens: 65536, supportsVision: true },
  'kimi-k3.1-pro-highspeed': { contextWindow: 1048576, maxOutputTokens: 65536, supportsVision: true },
} as const
