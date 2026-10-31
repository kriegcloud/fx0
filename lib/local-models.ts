// Direct CLIProxyAPI IDs, refreshed from its authenticated catalog on 2026-10-29.
// Listing is discovery, not proof of account entitlement or model capabilities.
// Keep these distinct from Gateway/Venice routes and send each ID unchanged.
export const KIMI_MODELS: Readonly<Record<string, string>> = {
  'kimi-k2': 'Kimi K2',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code Highspeed',
  'kimi-k2.8': 'Kimi K2.8',
  'kimi-k2.8-code': 'Kimi K2.8 Code',
  'kimi-k3': 'Kimi K3',
  'kimi-k3-256k': 'Kimi K3 256K',
  'kimi-k3.1-pro': 'Kimi K3.1 Pro',
  'kimi-k3.1-pro-highspeed': 'Kimi K3.1 Pro Highspeed',
}

export function isLocalTextModel(id: string): boolean {
  return Object.hasOwn(KIMI_MODELS, id) || (/^(gpt-|claude-|grok-)/.test(id) && !/image|video|tts|voice/.test(id))
}

export function modelDisplayName(id: string): string {
  return Object.hasOwn(KIMI_MODELS, id) ? KIMI_MODELS[id] : (id.split('/').at(-1) ?? id)
}
