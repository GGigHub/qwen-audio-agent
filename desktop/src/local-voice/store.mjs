import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeLocalVoiceConfig } from './definitions.mjs'

export function createLocalVoiceStore({ configPath }) {
  if (!configPath) throw new TypeError('local voice config path is required')

  function load() {
    if (!existsSync(configPath)) return normalizeLocalVoiceConfig()
    try {
      return normalizeLocalVoiceConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    } catch {
      return normalizeLocalVoiceConfig()
    }
  }

  function save(input) {
    const next = normalizeLocalVoiceConfig(input)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }

  return { path: configPath, load, save }
}
