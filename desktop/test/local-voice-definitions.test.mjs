import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLocalVoiceScheme,
  buildLocalVoiceLaunchArgs,
  joinRoot,
  localVoiceGatewayPatch,
  normalizeLocalVoiceConfig,
  requiredDiskGiB,
  resolveLocalModelName,
} from '../src/local-voice/definitions.mjs'
import { resolveSeedRoots } from '../src/local-voice/install.mjs'

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
  assert.ok(args.includes('--ws_port'))
  assert.ok(args.includes('8765'))
})

test('joinRoot follows Windows separators from install root', () => {
  assert.equal(
    joinRoot('F:\\GitProjects\\qwenAudioAgent', 'models', 'Qwen3-4B-Instruct-2507'),
    'F:\\GitProjects\\qwenAudioAgent\\models\\Qwen3-4B-Instruct-2507',
  )
  assert.equal(
    resolveLocalModelName({
      installRoot: 'F:\\GitProjects\\qwenAudioAgent',
      modelName: 'local-qwen3-4b',
    }),
    'F:\\GitProjects\\qwenAudioAgent\\models\\Qwen3-4B-Instruct-2507',
  )
})

test('joinRoot follows POSIX separators from install root', () => {
  assert.equal(
    joinRoot('/home/me/QwenAudioLocalVoice', 'models', 'Qwen3-TTS-12Hz-0.6B-CustomVoice'),
    '/home/me/QwenAudioLocalVoice/models/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  )
})

test('local mode patches gateway realtime fields', () => {
  const patch = localVoiceGatewayPatch({ mode: 'local' })
  assert.equal(patch.realtimeProvider, 'speech-to-speech')
  assert.equal(patch.realtimeUrl, 'ws://127.0.0.1:8765/v1/realtime')
  assert.equal(localVoiceGatewayPatch({ mode: 'cloud' }), null)
})

test('normalize keeps unknown keys out of broken enums', () => {
  const config = normalizeLocalVoiceConfig({ mode: 'nope', chatSize: '10', seedRoot: ' D:\\seed ' })
  assert.equal(config.mode, 'cloud')
  assert.equal(config.chatSize, 10)
  assert.equal(config.seedRoot, 'D:\\seed')
})

test('required disk budget grows for scheme A', () => {
  assert.equal(requiredDiskGiB('B'), 14)
  assert.equal(requiredDiskGiB('A'), 22)
})

test('resolveSeedRoots includes seed, env, and install roots', () => {
  const roots = resolveSeedRoots({
    seedRoot: 'D:\\seed',
    installRoot: 'D:\\install',
  }, { QWEN_LOCAL_VOICE_SEED_ROOT: 'E:\\env-seed' })
  assert.deepEqual(roots, ['D:\\seed', 'E:\\env-seed', 'D:\\install'])
})
