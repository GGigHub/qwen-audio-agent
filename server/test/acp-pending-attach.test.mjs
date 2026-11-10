import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  attachPendingPath,
  consumePendingAttach,
  writePendingAttach,
} from '../src/backend/adapters/acp/pending-attach.mjs'

test('writes and consumes a one-shot attach request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-attach-'))
  const sessionStatePath = join(directory, 'acp-sessions.json')
  const pendingPath = attachPendingPath(sessionStatePath)
  try {
    writePendingAttach(pendingPath, {
      sessionId: 'sess-1',
      cwd: '/work/project',
      protocol: 'deepseek',
    })
    const saved = JSON.parse(readFileSync(pendingPath, 'utf8'))
    assert.equal(saved.sessionId, 'sess-1')
    assert.equal(saved.protocol, 'deepseek')

    const first = consumePendingAttach(pendingPath, { protocol: 'deepseek' })
    assert.deepEqual(first, {
      sessionId: 'sess-1',
      cwd: '/work/project',
      protocol: 'deepseek',
      createdAt: saved.createdAt,
    })
    assert.equal(consumePendingAttach(pendingPath, { protocol: 'deepseek' }), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ignores attach requests for a different protocol', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-attach-proto-'))
  const pendingPath = attachPendingPath(join(directory, 'acp-sessions.json'))
  try {
    writePendingAttach(pendingPath, {
      sessionId: 'sess-2',
      cwd: '/work',
      protocol: 'deepseek',
    })
    assert.equal(consumePendingAttach(pendingPath, { protocol: 'opencode' }), null)
    const kept = JSON.parse(readFileSync(pendingPath, 'utf8'))
    assert.equal(kept.sessionId, 'sess-2')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
