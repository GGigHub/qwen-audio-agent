import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLocalVoiceScheme,
  buildLocalVoiceLaunchArgs,
  localVoiceGatewayPatch,
  normalizeLocalVoiceConfig,
} from '../src/local-voice/definitions.mjs'

test('scheme B defaults to chat-completions launch args', () => {
  const config = applyLocalVoiceScheme({
    installRoot: 'F:\\GitProjects\\qwenAudioAgent',
    mode: 'local',
  }, 'B')
  const args = buildLocalVoiceLaunchArgs(config)
  assert.equal(config.llmBackend, 'chat-completions')
  assert.ok(args.includes('paraformer'))
  assert.ok(args.includes('--no_smart_turn'))
  assert.ok(args.includes('deepseek-chat'))
})

test('local mode patches gateway realtime fields', () => {
  const patch = localVoiceGatewayPatch({ mode: 'local' })
  assert.equal(patch.realtimeProvider, 'speech-to-speech')
  assert.equal(patch.realtimeUrl, 'ws://127.0.0.1:8765/v1/realtime')
  assert.equal(localVoiceGatewayPatch({ mode: 'cloud' }), null)
})

test('normalize keeps unknown keys out of broken enums', () => {
  const config = normalizeLocalVoiceConfig({ mode: 'nope', chatSize: '10' })
  assert.equal(config.mode, 'cloud')
  assert.equal(config.chatSize, 10)
})
