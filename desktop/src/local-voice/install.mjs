import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { normalizeLocalVoiceConfig } from './definitions.mjs'

export const S2S_GIT_COMMIT = 'f75d6b435d89b8dff911f639672c172166595409'
export const DEFAULT_TORCH_INDEX = process.env.QWEN_LOCAL_VOICE_TORCH_INDEX
  || 'https://download.pytorch.org/whl/cu124'

const PARAFORMER_DIR = 'iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch'

export function defaultLocalVoiceInstallRoot() {
  return join(homedir(), 'QwenAudioLocalVoice')
}

function modelReady(dir) {
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

function speechExe(root) {
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

async function ensureSpeechToSpeech(root, { onLine, signal, env }) {
  const localSrc = join(root, 'src', 'speech-to-speech')
  if (existsSync(join(localSrc, 'pyproject.toml')) || existsSync(join(localSrc, 'setup.py'))) {
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

function syncParaformerCache(root, { onLine }) {
  const sourceCandidates = [
    join(root, 'models', 'modelscope', PARAFORMER_DIR),
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

async function downloadParaformer(root, { onLine, signal, env }) {
  const local = join(root, 'models', 'modelscope', PARAFORMER_DIR)
  await modelscopeDownload(
    root,
    'iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    local,
    { onLine, signal, env },
  )
  syncParaformerCache(root, { onLine })
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

  await ensureSpeechToSpeech(root, { onLine: emit, signal, env: childEnv })

  emit('下载 / 校验 TTS 与 Tokenizer…')
  await modelscopeDownload(
    root,
    'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    join(root, 'models', 'Qwen3-TTS-12Hz-0.6B-CustomVoice'),
    { onLine: emit, signal, env: childEnv },
  )
  await modelscopeDownload(
    root,
    'Qwen/Qwen3-TTS-Tokenizer-12Hz',
    join(root, 'models', 'Qwen3-TTS-Tokenizer-12Hz'),
    { onLine: emit, signal, env: childEnv },
  )

  emit('下载 / 校验 Paraformer 听写模型…')
  await downloadParaformer(root, { onLine: emit, signal, env: childEnv })

  if (config.scheme === 'A') {
    emit('方案 A：下载 Qwen3-4B…')
    await modelscopeDownload(
      root,
      'Qwen/Qwen3-4B-Instruct-2507',
      join(root, 'models', 'Qwen3-4B-Instruct-2507'),
      { onLine: emit, signal, env: childEnv },
    )
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
