import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  statfsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  normalizeLocalVoiceConfig,
  requiredDiskGiB,
} from './definitions.mjs'

export const S2S_GIT_COMMIT = 'f75d6b435d89b8dff911f639672c172166595409'
export const DEFAULT_TORCH_INDEX = process.env.QWEN_LOCAL_VOICE_TORCH_INDEX
  || 'https://download.pytorch.org/whl/cu124'

const PARAFORMER_DIR = 'iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch'

const MODEL_SPECS = Object.freeze([
  {
    id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    relative: ['models', 'Qwen3-TTS-12Hz-0.6B-CustomVoice'],
    schemes: ['A', 'B'],
  },
  {
    id: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
    relative: ['models', 'Qwen3-TTS-Tokenizer-12Hz'],
    schemes: ['A', 'B'],
  },
  {
    id: 'iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    relative: ['models', 'modelscope', PARAFORMER_DIR],
    schemes: ['A', 'B'],
    paraformer: true,
  },
  {
    id: 'Qwen/Qwen3-4B-Instruct-2507',
    relative: ['models', 'Qwen3-4B-Instruct-2507'],
    schemes: ['A'],
  },
])

export function defaultLocalVoiceInstallRoot() {
  return join(homedir(), 'QwenAudioLocalVoice')
}

export function modelReady(dir) {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some(name => !name.startsWith('.'))
  } catch {
    return false
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('安装已取消')
}

function runCommand(command, args, {
  cwd,
  env = process.env,
  onLine = () => {},
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const onData = (chunk, stream) => {
      const text = String(chunk)
      if (stream === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line)
      }
    }
    child.stdout?.on('data', chunk => onData(chunk, 'stdout'))
    child.stderr?.on('data', chunk => onData(chunk, 'stderr'))
    const onAbort = () => {
      try { child.kill() } catch { /* ignore */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', reject)
    child.on('exit', code => {
      if (signal) signal.removeEventListener?.('abort', onAbort)
      if (signal?.aborted) {
        reject(new Error('安装已取消'))
        return
      }
      if (code === 0) {
        resolve({ stdout, stderr, code })
        return
      }
      const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-8).join('\n')
      reject(new Error(`${command} ${args.join(' ')} 失败 (exit ${code})${detail ? `\n${detail}` : ''}`))
    })
  })
}

async function resolvePython({ onLine }) {
  const candidates = [
    ['py', ['-3.12', '-c', 'import sys; print(sys.executable)']],
    ['py', ['-3.11', '-c', 'import sys; print(sys.executable)']],
    ['python', ['-c', 'import sys; print(sys.executable)']],
    ['python3', ['-c', 'import sys; print(sys.executable)']],
  ]
  for (const [command, args] of candidates) {
    try {
      const result = await runCommand(command, args, {
        onLine: line => onLine(`[python] ${line}`),
      })
      const exe = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
      if (exe && existsSync(exe)) {
        onLine(`使用 Python：${exe}`)
        return exe
      }
    } catch {
      // try next
    }
  }
  throw new Error('未找到 Python 3.11/3.12。请先安装并勾选 Add python.exe to PATH：https://www.python.org/downloads/windows/')
}

function venvPython(root) {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'python.exe')
    : join(root, 'venv', 'bin', 'python')
}

function venvPip(root) {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'pip.exe')
    : join(root, 'venv', 'bin', 'pip')
}

export function speechExe(root) {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'speech-to-speech.exe')
    : join(root, 'venv', 'bin', 'speech-to-speech')
}

async function ensureVenv(root, pythonExe, { onLine, signal }) {
  const py = venvPython(root)
  if (existsSync(py)) {
    onLine(`复用已有 venv：${py}`)
    return py
  }
  onLine('创建 venv…')
  await runCommand(pythonExe, ['-m', 'venv', join(root, 'venv')], {
    cwd: root,
    onLine,
    signal,
  })
  if (!existsSync(py)) throw new Error(`venv 创建失败：未找到 ${py}`)
  return py
}

async function pipInstall(root, args, { onLine, signal, env }) {
  const pip = venvPip(root)
  const py = venvPython(root)
  const command = existsSync(pip) ? pip : py
  const finalArgs = existsSync(pip) ? args : ['-m', 'pip', ...args]
  await runCommand(command, finalArgs, {
    cwd: root,
    env,
    onLine,
    signal,
  })
}

export function resolveSeedRoots(config = {}, env = process.env) {
  const normalized = normalizeLocalVoiceConfig(config)
  const roots = []
  const add = value => {
    const path = String(value || '').trim().replace(/[\\/]+$/, '')
    if (path && !roots.includes(path)) roots.push(path)
  }
  add(normalized.seedRoot)
  add(env.QWEN_LOCAL_VOICE_SEED_ROOT)
  add(normalized.installRoot)
  return roots
}

function findSeededModel(relativeParts, seedRoots) {
  for (const seed of seedRoots) {
    const candidate = join(seed, ...relativeParts)
    if (modelReady(candidate)) return candidate
  }
  return ''
}

function findSpeechSource(seedRoots, installRoot) {
  const candidates = [
    join(installRoot, 'src', 'speech-to-speech'),
    ...seedRoots.map(seed => join(seed, 'src', 'speech-to-speech')),
  ]
  return candidates.find(path => (
    existsSync(join(path, 'pyproject.toml')) || existsSync(join(path, 'setup.py'))
  )) || ''
}

async function ensureSpeechToSpeech(root, seedRoots, { onLine, signal, env }) {
  const localSrc = findSpeechSource(seedRoots, root)
  if (localSrc) {
    onLine(`从本地源码安装 speech-to-speech：${localSrc}`)
    await pipInstall(root, ['install', `${localSrc}[paraformer]`], { onLine, signal, env })
    return
  }
  onLine(`从 Git 安装 speech-to-speech@${S2S_GIT_COMMIT}（需要本机 Git）…`)
  await pipInstall(root, [
    'install',
    `git+https://github.com/huggingface/speech-to-speech.git@${S2S_GIT_COMMIT}#egg=speech-to-speech[paraformer]`,
  ], { onLine, signal, env })
}

async function modelscopeDownload(root, modelId, localDir, { onLine, signal, env }) {
  if (modelReady(localDir)) {
    onLine(`已有模型，跳过：${localDir}`)
    return
  }
  ensureDir(dirname(localDir))
  onLine(`下载模型 ${modelId} → ${localDir}`)
  const py = venvPython(root)
  await runCommand(py, [
    '-m', 'modelscope', 'download',
    '--model', modelId,
    '--local_dir', localDir,
  ], { cwd: root, env, onLine, signal })
  if (!modelReady(localDir)) {
    throw new Error(`模型下载后目录仍为空：${localDir}`)
  }
}

function syncParaformerCache(root, seedRoots, { onLine }) {
  const sourceCandidates = [
    join(root, 'models', 'modelscope', PARAFORMER_DIR),
    ...seedRoots.map(seed => join(seed, 'models', 'modelscope', PARAFORMER_DIR)),
    join(homedir(), '.cache', 'modelscope', 'models', PARAFORMER_DIR),
  ]
  const source = sourceCandidates.find(path => modelReady(path))
  const cache = join(homedir(), '.cache', 'modelscope', 'models', PARAFORMER_DIR)
  if (!source) {
    onLine('警告：未找到 Paraformer 缓存，首次启动可能再向魔搭拉取')
    return
  }
  if (source === cache) {
    onLine(`Paraformer 已在 FunASR 缓存：${cache}`)
    return
  }
  ensureDir(dirname(cache))
  onLine(`同步 Paraformer 到 FunASR 缓存：${cache}`)
  cpSync(source, cache, { recursive: true, force: true })
}

function seedModelsIntoRoot(root, scheme, seedRoots, { onLine }) {
  const needed = MODEL_SPECS.filter(spec => spec.schemes.includes(scheme))
  let copied = 0
  for (const spec of needed) {
    const dest = join(root, ...spec.relative)
    if (modelReady(dest)) {
      onLine(`安装目录已有：${dest}`)
      continue
    }
    const source = findSeededModel(spec.relative, seedRoots.filter(seed => seed !== root))
    if (!source) continue
    ensureDir(dirname(dest))
    onLine(`离线复用模型：${source} → ${dest}`)
    cpSync(source, dest, { recursive: true, force: true })
    copied += 1
  }
  return copied
}

function readFreeDiskGiB(targetPath) {
  try {
    const probe = existsSync(targetPath) ? targetPath : dirname(targetPath)
    if (typeof statfsSync === 'function') {
      const stats = statfsSync(probe)
      const free = Number(stats.bavail) * Number(stats.bsize)
      if (Number.isFinite(free) && free > 0) return free / (1024 ** 3)
    }
  } catch {
    // fall through
  }
  return null
}

async function detectGpu() {
  try {
    const result = await runCommand('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader',
    ], { onLine: () => {} })
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] || ''
    if (!line) return { ok: false, message: '未检测到 NVIDIA GPU（nvidia-smi 无输出）' }
    return { ok: true, message: line.trim(), raw: line.trim() }
  } catch {
    return {
      ok: false,
      message: '未找到 nvidia-smi。方案 B/A 默认需要 NVIDIA GPU；也可在高级里改 device=cpu（很慢）。',
    }
  }
}

/**
 * Pre-install checks: Python, GPU, free disk.
 */
export async function preflightLocalVoice(input = {}, {
  env = process.env,
} = {}) {
  const config = normalizeLocalVoiceConfig(input)
  const root = (config.installRoot || defaultLocalVoiceInstallRoot()).replace(/[\\/]+$/, '')
  const warnings = []
  const errors = []
  const notes = []

  let python = null
  try {
    python = await resolvePython({ onLine: () => {} })
    notes.push(`Python：${python}`)
  } catch (error) {
    errors.push(String(error?.message || error))
  }

  const gpu = await detectGpu()
  if (gpu.ok) notes.push(`GPU：${gpu.message}`)
  else if (config.device === 'cuda') warnings.push(gpu.message)
  else notes.push(gpu.message)

  const needGiB = requiredDiskGiB(config.scheme)
  const freeGiB = readFreeDiskGiB(root)
  if (freeGiB == null) {
    warnings.push(`无法读取磁盘剩余空间；请确认 ${root} 所在盘至少约 ${needGiB} GB 可用。`)
  } else {
    notes.push(`磁盘剩余约 ${freeGiB.toFixed(1)} GB（建议 ≥ ${needGiB} GB）`)
    if (freeGiB + 0.1 < needGiB) {
      errors.push(`磁盘空间不足：约 ${freeGiB.toFixed(1)} GB，方案 ${config.scheme} 建议至少 ${needGiB} GB。`)
    }
  }

  const seedRoots = resolveSeedRoots({ ...config, installRoot: root }, env)
  const seedHits = MODEL_SPECS
    .filter(spec => spec.schemes.includes(config.scheme))
    .filter(spec => findSeededModel(spec.relative, seedRoots))
  if (seedHits.length) {
    notes.push(`可离线复用 ${seedHits.length} 个模型目录（来自 seed/安装根）`)
  }
  const speechSrc = findSpeechSource(seedRoots, root)
  if (speechSrc) notes.push(`可离线安装 speech-to-speech 源码：${speechSrc}`)

  return {
    ok: errors.length === 0,
    installRoot: root,
    scheme: config.scheme,
    python,
    gpu,
    freeDiskGiB: freeGiB,
    requiredDiskGiB: needGiB,
    seedRoots,
    warnings,
    errors,
    notes,
    message: errors.length
      ? errors[0]
      : (warnings.length ? `预检通过（有警告）：${warnings[0]}` : '预检通过，可以开始一键安装'),
  }
}

/**
 * One-click local voice frontend install into installRoot.
 * Does not install or configure dsh.
 */
export async function installLocalVoice(input = {}, {
  onProgress = () => {},
  signal,
  env = process.env,
  torchIndex = DEFAULT_TORCH_INDEX,
  skipPreflight = false,
} = {}) {
  const config = normalizeLocalVoiceConfig(input)
  const root = (config.installRoot || defaultLocalVoiceInstallRoot()).replace(/[\\/]+$/, '')
  const logDir = ensureDir(join(root, 'logs'))
  const logFile = join(logDir, 'install.log')
  writeFileSync(logFile, `=== local voice install ${new Date().toISOString()} ===\n`, 'utf8')

  const emit = (message, extra = {}) => {
    const line = String(message || '').trimEnd()
    if (!line) return
    appendFileSync(logFile, `${line}\n`, 'utf8')
    onProgress({ phase: extra.phase || 'install', message: line, logFile, ...extra })
  }

  ensureDir(root)
  ensureDir(join(root, 'models'))
  emit(`安装根目录：${root}`)
  emit(`方案：${config.scheme === 'A' ? 'A 全本地 4B' : 'B DeepSeek 闲聊（需本机已配置 dsh Key）'}`)
  emit('说明：本安装只部署语音前台；dsh 仍需你手动安装并配置。')

  if (!skipPreflight) {
    emit('安装前预检…', { phase: 'preflight' })
    const preflight = await preflightLocalVoice({ ...config, installRoot: root }, { env })
    for (const note of preflight.notes) emit(note, { phase: 'preflight' })
    for (const warning of preflight.warnings) emit(`警告：${warning}`, { phase: 'preflight' })
    if (!preflight.ok) {
      throw new Error(preflight.errors.join('\n') || preflight.message)
    }
  }

  throwIfAborted(signal)
  const seedRoots = resolveSeedRoots({ ...config, installRoot: root }, env)
  if (seedRoots.length) emit(`离线源目录：${seedRoots.join(' | ')}`)
  const seeded = seedModelsIntoRoot(root, config.scheme, seedRoots, { onLine: emit })
  if (seeded) emit(`已离线复用 ${seeded} 个模型目录`)

  const pythonExe = await resolvePython({ onLine: emit })
  await ensureVenv(root, pythonExe, { onLine: emit, signal })

  const childEnv = { ...env }
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  ]) {
    delete childEnv[key]
  }
  // Keep pip build scratch out of the install root (otherwise pip-* dirs litter the project).
  const pipTemp = ensureDir(join(tmpdir(), 'qwen-audio-local-voice-pip'))
  childEnv.TEMP = pipTemp
  childEnv.TMP = pipTemp
  childEnv.TMPDIR = pipTemp
  emit(`pip 临时目录：${pipTemp}`)

  emit('升级 pip / modelscope…')
  await pipInstall(root, ['install', '-U', 'pip', 'modelscope'], {
    onLine: emit, signal, env: childEnv,
  })

  emit(`安装 CUDA 版 PyTorch（index: ${torchIndex}）…`)
  await pipInstall(root, [
    'install', 'torch', 'torchaudio',
    '--index-url', torchIndex,
  ], { onLine: emit, signal, env: childEnv })

  await ensureSpeechToSpeech(root, seedRoots, { onLine: emit, signal, env: childEnv })

  emit('下载 / 校验 TTS 与 Tokenizer…')
  for (const spec of MODEL_SPECS.filter(item => item.schemes.includes(config.scheme) && !item.paraformer && !item.id.includes('4B'))) {
    await modelscopeDownload(root, spec.id, join(root, ...spec.relative), {
      onLine: emit, signal, env: childEnv,
    })
  }

  emit('下载 / 校验 Paraformer 听写模型…')
  const para = MODEL_SPECS.find(item => item.paraformer)
  await modelscopeDownload(root, para.id, join(root, ...para.relative), {
    onLine: emit, signal, env: childEnv,
  })
  syncParaformerCache(root, seedRoots, { onLine: emit })

  if (config.scheme === 'A') {
    emit('方案 A：下载 / 校验 Qwen3-4B…')
    const llm = MODEL_SPECS.find(item => item.id.includes('4B'))
    await modelscopeDownload(root, llm.id, join(root, ...llm.relative), {
      onLine: emit, signal, env: childEnv,
    })
  } else {
    emit('方案 B：跳过本地 4B 权重（闲聊走 DeepSeek，依赖 dsh Key）。')
  }

  const exe = speechExe(root)
  if (!existsSync(exe)) {
    throw new Error(`安装完成但未找到 ${exe}`)
  }

  emit(`安装完成：${exe}`, { phase: 'done' })
  emit(`详细日志：${logFile}`, { phase: 'done' })
  return {
    ok: true,
    installRoot: root,
    executable: exe,
    logFile,
    message: '本地语音前台已安装。请先「启动本地语音」，再点「应用」。dsh 需另行手动安装配置。',
  }
}
