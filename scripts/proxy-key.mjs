import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'

// Launcher-only: no browser imports, logging, or credential persistence.
export async function readProxyKey(env = process.env, home = homedir()) {
  if (env.FX0_PROXY_API_KEY?.trim()) return env.FX0_PROXY_API_KEY.trim()
  // Preserve an explicitly selected config. Otherwise prefer the workstation's
  // dedicated client token, falling back only when the default file is absent.
  if (env.FX0_PROXY_TOKEN_FILE || !env.FX0_PROXY_CONFIG) {
    try {
      const key = (await readFile(env.FX0_PROXY_TOKEN_FILE || path.join(home, '.cli-proxy-api/client-token'), 'utf8')).trim()
      if (!key) throw new Error('The CLIProxyAPI client token file is empty')
      return key
    } catch (error) {
      if (env.FX0_PROXY_TOKEN_FILE || error.code !== 'ENOENT') throw error
    }
  }
  // Do not propagate YAML parse errors: they can quote credential source text.
  let config
  try { config = parse(await readFile(env.FX0_PROXY_CONFIG || path.join(home, '.cli-proxy-api/config.yaml'), 'utf8')) }
  catch { throw new Error('Unable to read CLIProxyAPI client configuration') }
  const key = config?.['api-keys']?.find?.(value => typeof value === 'string' && value.trim())
  if (!key) throw new Error('Set FX0_PROXY_TOKEN_FILE, FX0_PROXY_API_KEY, or a CLIProxyAPI config with api-keys')
  return key.trim()
}
