import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function clean(value) {
  return String(value || '').trim()
}

export function attachPendingPath(sessionStatePath) {
  if (!sessionStatePath) return null
  return join(dirname(String(sessionStatePath)), 'acp-attach-pending.json')
}

export function writePendingAttach(filePath, {
  sessionId,
  cwd = '',
  protocol = '',
} = {}) {
  const path = clean(filePath)
  const id = clean(sessionId)
  if (!path || !id) {
    throw new Error('attach 需要有效的 session id 与状态文件路径')
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const payload = {
    sessionId: id,
    cwd: clean(cwd),
    protocol: clean(protocol).toLowerCase(),
    createdAt: Date.now(),
  }
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return payload
}

export function consumePendingAttach(filePath, { protocol = '' } = {}) {
  const path = clean(filePath)
  if (!path || !existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    try { unlinkSync(path) } catch { /* ignore corrupt cleanup */ }
    return null
  }
  const expected = clean(protocol).toLowerCase()
  const recorded = clean(parsed?.protocol).toLowerCase()
  if (expected && recorded && recorded !== expected) return null
  try { unlinkSync(path) } catch { /* already consumed */ }
  const sessionId = clean(parsed?.sessionId)
  if (!sessionId) return null
  return {
    sessionId,
    cwd: clean(parsed?.cwd),
    protocol: recorded,
    createdAt: Number(parsed?.createdAt) || 0,
  }
}
