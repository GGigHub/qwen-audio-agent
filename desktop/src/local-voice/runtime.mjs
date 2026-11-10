import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import {
  LOCAL_VOICE_PORT,
  buildLocalVoiceLaunchArgs,
  normalizeLocalVoiceConfig,
} from './definitions.mjs'

function speechExe(root) {
  return join(root, 'venv', 'Scripts', 'speech-to-speech.exe')
}

function probePort(port = LOCAL_VOICE_PORT, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    const done = ok => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function readDeepSeekKey() {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(path)) return ''
  const text = readFileSync(path, 'utf8')
  const match = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!match) return ''
  return match[1].replace(/^['"]|['"]$/g, '')
}

export function createLocalVoiceRuntime({
  store,
  env = process.env,
} = {}) {
  let child = null

  function inspect(config = store.load()) {
    const normalized = normalizeLocalVoiceConfig(config)
    const root = normalized.installRoot
    const exe = root ? speechExe(root) : ''
    const installed = Boolean(root && existsSync(exe))
    return {
      config: normalized,
      installRoot: root,
      executable: exe,
      installed,
      runningPid: child?.pid || null,
    }
  }

  async function status(config) {
    const info = inspect(config)
    const listening = await probePort()
    return {
      ...info,
      listening,
      phase: !info.installed
        ? 'missing'
        : listening || child
          ? 'running'
          : 'stopped',
    }
  }

  async function start(input) {
    const config = store.save(input || store.load())
    const info = inspect(config)
    if (!info.installed) {
      throw new Error('本地语音未安装：请先选择安装根目录并完成安装检测')
    }
    if (await probePort()) {
      return status(config)
    }
    if (child && !child.killed) {
      return status(config)
    }

    const args = buildLocalVoiceLaunchArgs(config)
    const childEnv = { ...env }
    for (const key of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    ]) {
      delete childEnv[key]
    }
    if (config.cudaAlloc && config.cudaAlloc !== 'none') {
      childEnv.PYTORCH_CUDA_ALLOC_CONF = config.cudaAlloc
    }
    if (config.keySource === 'dsh' || config.keySource === 'env') {
      const key = config.keySource === 'dsh' ? readDeepSeekKey() : (env.DEEPSEEK_API_KEY || '')
      if (key) {
        childEnv.DEEPSEEK_API_KEY = key
        childEnv.OPENAI_API_KEY = key
        if (config.llmBackend === 'chat-completions' || config.llmBackend === 'responses-api') {
          args.push('--responses_api_api_key', key)
        }
      }
    }

    child = spawn(info.executable, args, {
      cwd: info.installRoot,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    child.on('exit', () => {
      if (child) child = null
    })

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (await probePort()) return status(config)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    throw new Error('本地语音启动超时：请检查安装根目录与 GPU 环境')
  }

  async function stop() {
    if (child?.pid) {
      try {
        process.kill(child.pid)
      } catch {
        // Process may already be gone.
      }
      child = null
    }
    // Best-effort: also kill any speech-to-speech still holding the port on Windows.
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('powershell.exe', [
          '-NoProfile',
          '-Command',
          `$p = Get-NetTCPConnection -LocalPort ${LOCAL_VOICE_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }`,
        ], { windowsHide: true })
        killer.on('exit', resolve)
        killer.on('error', resolve)
      })
    }
    return status()
  }

  function verifyInstall(input) {
    const config = store.save(input || store.load())
    const info = inspect(config)
    if (!config.installRoot) {
      throw new Error('请先填写安装根目录')
    }
    if (!existsSync(config.installRoot)) {
      throw new Error(`安装根目录不存在：${config.installRoot}`)
    }
    if (!info.installed) {
      throw new Error(
        `未找到 ${info.executable}。请先在该目录准备 venv（见工程 scripts/start-local.ps1 / docs 部署方案）。`,
      )
    }
    const tts = join(config.installRoot, 'models', 'Qwen3-TTS-12Hz-0.6B-CustomVoice')
    const missing = []
    if (!existsSync(tts)) missing.push('models/Qwen3-TTS-12Hz-0.6B-CustomVoice')
    if (config.scheme === 'A') {
      const llm = join(config.installRoot, 'models', 'Qwen3-4B-Instruct-2507')
      if (!existsSync(llm)) missing.push('models/Qwen3-4B-Instruct-2507')
    }
    return {
      ...info,
      ok: missing.length === 0,
      missing,
      message: missing.length
        ? `已检测到程序，仍缺：${missing.join('、')}`
        : '本地语音安装已就绪',
    }
  }

  return {
    inspect,
    status,
    start,
    stop,
    verifyInstall,
    save: input => store.save(input),
    load: () => store.load(),
  }
}
