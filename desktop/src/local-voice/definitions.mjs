// Browser-safe local speech-to-speech launch enums and command builders.
// Keep Node-only APIs out of this module so settings renderer can import it.

export const LOCAL_VOICE_PROVIDER = 'speech-to-speech'
export const LOCAL_VOICE_REALTIME_URL = 'ws://127.0.0.1:8765/v1/realtime'
export const LOCAL_VOICE_PORT = 8765

export const LOCAL_VOICE_DEFAULTS = Object.freeze({
  mode: 'cloud',
  installRoot: '',
  scheme: 'B',
  stt: 'paraformer',
  llmBackend: 'chat-completions',
  modelName: 'deepseek-chat',
  apiBaseUrl: 'https://api.deepseek.com',
  stream: true,
  chatSize: 10,
  tts: 'qwen3',
  ttsBackend: 'torch',
  speaker: 'Vivian',
  language: 'chinese',
  instruct: '请用平稳、自然、克制的语气说话，保持均匀语速，避免夸张的音高变化，句末自然收束。',
  device: 'cuda',
  smartTurn: false,
  cudaAlloc: 'expandable_segments:True',
  keySource: 'dsh',
})

export const LOCAL_VOICE_ENUMS = Object.freeze({
  scheme: Object.freeze([
    { value: 'B', label: '方案 B · 推荐', description: '听写/TTS 本地；闲聊 LLM 走 DeepSeek。显存约 3 GB。' },
    { value: 'A', label: '方案 A · 全本地', description: '闲聊也用本机 Qwen3-4B。显存约 12 GB。' },
  ]),
  stt: Object.freeze([
    { value: 'paraformer', label: 'paraformer', description: '中文听写主路径（Paraformer-zh）' },
    { value: 'parakeet-tdt', label: 'parakeet-tdt', description: '上游默认之一，偏英文' },
    { value: 'faster-whisper', label: 'faster-whisper', description: 'Whisper 加速版' },
    { value: 'whisper', label: 'whisper', description: '原版 Whisper' },
    { value: 'none', label: 'none', description: '不听写，音频直送音频 LLM' },
  ]),
  llmBackend: Object.freeze([
    { value: 'chat-completions', label: 'chat-completions', description: 'OpenAI 兼容接口（方案 B）' },
    { value: 'transformers', label: 'transformers', description: '本机加载 HF 模型（方案 A）' },
    { value: 'responses-api', label: 'responses-api', description: 'OpenAI Responses 风格' },
    { value: 'mlx-lm', label: 'mlx-lm', description: 'Apple Silicon 本地 LLM' },
  ]),
  modelName: Object.freeze([
    { value: 'deepseek-chat', label: 'deepseek-chat', description: 'DeepSeek 对话（方案 B）' },
    { value: 'local-qwen3-4b', label: '本地 Qwen3-4B', description: '映射到 models/Qwen3-4B-Instruct-2507' },
    { value: 'deepseek-reasoner', label: 'deepseek-reasoner', description: '推理模型，口语会变慢' },
  ]),
  apiBaseUrl: Object.freeze([
    { value: 'https://api.deepseek.com', label: 'DeepSeek 官方', description: '方案 B 默认' },
    { value: 'https://api.openai.com/v1', label: 'OpenAI 兼容示例', description: '需对应 Key 与模型' },
  ]),
  chatSize: Object.freeze([
    { value: 5, label: '5', description: '更省上下文' },
    { value: 10, label: '10', description: '本工程推荐' },
    { value: 20, label: '20', description: '更长记忆' },
    { value: 30, label: '30', description: '上游默认量级' },
  ]),
  tts: Object.freeze([
    { value: 'qwen3', label: 'qwen3', description: '本工程中文主路径' },
    { value: 'kokoro', label: 'kokoro', description: '轻量备选' },
    { value: 'chatTTS', label: 'chatTTS', description: 'ChatTTS' },
  ]),
  ttsBackend: Object.freeze([
    { value: 'torch', label: 'torch', description: 'NVIDIA / 通用' },
    { value: 'ggml', label: 'ggml', description: 'qwentts.cpp' },
  ]),
  speaker: Object.freeze([
    { value: 'Vivian', label: 'Vivian', description: '本工程中文推荐' },
    { value: 'Aiden', label: 'Aiden', description: '上游默认示例' },
  ]),
  language: Object.freeze([
    { value: 'chinese', label: 'chinese', description: '固定中文' },
    { value: 'auto', label: 'auto', description: '自动检测' },
    { value: 'english', label: 'english', description: '英语' },
  ]),
  device: Object.freeze([
    { value: 'cuda', label: 'cuda', description: 'NVIDIA GPU' },
    { value: 'cpu', label: 'cpu', description: '仅 CPU，不适合实时' },
    { value: 'mps', label: 'mps', description: 'Apple Silicon' },
  ]),
  keySource: Object.freeze([
    { value: 'dsh', label: 'dsh 凭据', description: '从 ~/.dsh/.credentials.yaml 读取' },
    { value: 'env', label: '环境变量', description: '使用进程中的 DEEPSEEK_API_KEY' },
  ]),
})

export function normalizeLocalVoiceConfig(input = {}) {
  const next = { ...LOCAL_VOICE_DEFAULTS, ...input }
  next.mode = next.mode === 'local' ? 'local' : 'cloud'
  next.scheme = next.scheme === 'A' ? 'A' : 'B'
  next.stream = next.stream !== false
  next.smartTurn = next.smartTurn === true
  next.chatSize = Number(next.chatSize) || 10
  next.installRoot = String(next.installRoot || '').trim()
  next.instruct = String(next.instruct || LOCAL_VOICE_DEFAULTS.instruct)
  return next
}

export function applyLocalVoiceScheme(config, scheme) {
  const next = normalizeLocalVoiceConfig({ ...config, scheme })
  if (scheme === 'A') {
    next.llmBackend = 'transformers'
    next.modelName = 'local-qwen3-4b'
  } else {
    next.llmBackend = 'chat-completions'
    next.modelName = 'deepseek-chat'
    next.apiBaseUrl = 'https://api.deepseek.com'
  }
  return next
}

export function resolveLocalModelName(config) {
  const normalized = normalizeLocalVoiceConfig(config)
  if (normalized.modelName !== 'local-qwen3-4b') return normalized.modelName
  if (!normalized.installRoot) return normalized.modelName
  return `${normalized.installRoot.replace(/[\\/]+$/, '')}\\models\\Qwen3-4B-Instruct-2507`
}

export function buildLocalVoiceLaunchArgs(config) {
  const normalized = normalizeLocalVoiceConfig(config)
  const root = normalized.installRoot.replace(/[\\/]+$/, '')
  const args = [
    '--stt', normalized.stt,
    '--llm_backend', normalized.llmBackend,
    '--model_name', resolveLocalModelName(normalized),
    '--chat_size', String(normalized.chatSize),
    '--tts', normalized.tts,
    '--device', normalized.device,
  ]
  if (normalized.llmBackend === 'chat-completions' || normalized.llmBackend === 'responses-api') {
    args.push('--responses_api_base_url', normalized.apiBaseUrl)
    if (normalized.stream) args.push('--responses_api_stream')
  }
  if (normalized.tts === 'qwen3') {
    args.push(
      '--qwen3_tts_backend', normalized.ttsBackend,
      '--qwen3_tts_model_name', `${root}\\models\\Qwen3-TTS-12Hz-0.6B-CustomVoice`,
      '--qwen3_tts_speaker', normalized.speaker,
      '--qwen3_tts_language', normalized.language,
      '--qwen3_tts_instruct', normalized.instruct,
    )
  }
  if (!normalized.smartTurn) args.push('--no_smart_turn')
  return args
}

export function localVoiceGatewayPatch(config) {
  const normalized = normalizeLocalVoiceConfig(config)
  if (normalized.mode !== 'local') return null
  return {
    realtimeProvider: LOCAL_VOICE_PROVIDER,
    realtimeUrl: LOCAL_VOICE_REALTIME_URL,
    realtimeModel: '',
    realtimeVoice: '',
    realtimeApiKey: '',
  }
}
