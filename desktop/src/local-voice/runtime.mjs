import { existsSync, readFileSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import {
  LOCAL_VOICE_PORT,
  buildLocalVoiceLaunchArgs,
  normalizeLocalVoiceConfig,
} from './definitions.mjs'
import { installLocalVoice, defaultLocalVoiceInstallRoot } from './install.mjs'

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

function readTail(file, maxChars = 4000) {
  if (!file || !existsSync(file)) return ''
  try {
    const text = readFileSync(file, 'utf8')
    return text.length <= maxChars ? text : text.slice(-maxChars)
  } catch {
    return ''
  }
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function createLocalVoiceRuntime({
  store,
  env = process.env,
} = {}) {
  let child = null
  let lastLogFile = ''

  function inspect(config = store.load()) {
    const normalized = normalizeLocalVoiceConfig(config)
    const root = normalized.installRoot
    const exe = root ? speechExe(root) : ''
    const installed = Boolean(root && existsSync(exe))
    const logFile = root ? join(root, 'logs', 'speech-to-speech.log') : ''
    return {
      config: normalized,
      installRoot: root,
      executable: exe,
      installed,
      runningPid: child?.pid || null,
      logFile: logFile || lastLogFile || '',
    }
  }

  async function status(config) {
    const info = inspect(config)
    const listening = await probePort()
    return {
      ...info,
      listening,
      logTail: readTail(info.logFile),
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
      throw new Error('本地语音未安装：请先点「一键安装 / 更新本地语音」')
    }
    if (await probePort()) {
      return status(config)
    }
    if (child && !child.killed) {
      return status(config)
    }

    if (
      (config.scheme !== 'A')
      && (config.llmBackend === 'chat-completions' || config.llmBackend === 'responses-api')
      && (config.keySource === 'dsh' || config.keySource === 'env')
    ) {
      const key = config.keySource === 'dsh' ? readDeepSeekKey() : (env.DEEPSEEK_API_KEY || '')
      if (!key) {
        throw new Error(
          '未读到 DeepSeek API Key。方案 B 需要先手动安装并配置 dsh（~/.dsh/.credentials.yaml），或改用环境变量 DEEPSEEK_API_KEY。',
        )
      }
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
    let apiKey = ''
    if (config.keySource === 'dsh' || config.keySource === 'env') {
      apiKey = config.keySource === 'dsh' ? readDeepSeekKey() : (env.DEEPSEEK_API_KEY || '')
      if (apiKey) {
        childEnv.DEEPSEEK_API_KEY = apiKey
        childEnv.OPENAI_API_KEY = apiKey
        if (config.llmBackend === 'chat-completions' || config.llmBackend === 'responses-api') {
          args.push('--responses_api_api_key', apiKey)
        }
      }
    }

    const logDir = join(info.installRoot, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, 'speech-to-speech.log')
    lastLogFile = logFile
    writeFileSync(
      logFile,
      `=== speech-to-speech start ${new Date().toISOString()} ===\n${info.executable} ${args.join(' ')}\n\n`,
      'utf8',
    )

    // Prefer a visible PowerShell worker (same idea as scripts/start-local.ps1) so
    // testers can see load progress; also tee into installRoot/logs.
    if (process.platform === 'win32') {
      const workerPath = join(logDir, 'start-worker.ps1')
      const argList = args.map(psQuote).join(', ')
      const script = [
        '$ErrorActionPreference = "Continue"',
        '$Host.UI.RawUI.WindowTitle = "语音服务（请勿关闭）"',
        `Set-Location -LiteralPath ${psQuote(info.installRoot)}`,
        foreachEnvClear(),
        config.cudaAlloc && config.cudaAlloc !== 'none'
          ? `$env:PYTORCH_CUDA_ALLOC_CONF = ${psQuote(config.cudaAlloc)}`
          : '',
        apiKey ? `$env:DEEPSEEK_API_KEY = ${psQuote(apiKey)}; $env:OPENAI_API_KEY = ${psQuote(apiKey)}` : '',
        `Write-Host "正在加载听写和朗读，大约需要一分钟。日志：${logFile}"`,
        `$exe = ${psQuote(info.executable)}`,
        `$argList = @(${argList})`,
        `$log = ${psQuote(logFile)}`,
        '& $exe @argList 2>&1 | ForEach-Object { $line = "$_"; Add-Content -LiteralPath $log -Value $line; $_ }',
        'Write-Host "语音服务已退出。按任意键关闭窗口。"',
        'pause',
      ].filter(Boolean).join('\r\n')
      writeFileSync(workerPath, script, 'utf8')
      child = spawn('powershell.exe', [
        '-NoExit',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', workerPath,
      ], {
        cwd: info.installRoot,
        env: childEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } else {
      const out = openSync(logFile, 'a')
      child = spawn(info.executable, args, {
        cwd: info.installRoot,
        env: childEnv,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      })
      closeSync(out)
    }
    child.unref()
    child.on('exit', () => {
      if (child) child = null
    })

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (await probePort()) {
        const ready = await status(config)
        return { ...ready, logFile, message: '本地语音已在 8765 监听' }
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const tail = readTail(logFile)
    throw new Error(
      `本地语音启动超时（未监听 8765）。请查看日志：${logFile}`
      + (tail ? `\n--- log ---\n${tail}` : '\n（日志为空：进程可能立刻退出或 GPU/模型路径异常）'),
    )
  }

  function foreachEnvClear() {
    return [
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    ].map(name => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`).join('; ')
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
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('powershell.exe', [
          '-NoProfile',
          '-Command',
          `$p = Get-NetTCPConnection -LocalPort ${LOCAL_VOICE_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter "Name='speech-to-speech.exe'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
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
      throw new Error('请先填写安装根目录（可留空后点一键安装，将使用用户目录默认路径）')
    }
    if (!existsSync(config.installRoot)) {
      throw new Error(`安装根目录不存在：${config.installRoot}。可点「一键安装」自动创建。`)
    }
    if (!info.installed) {
      throw new Error(
        `未找到 ${info.executable}。请点「一键安装 / 更新本地语音」。`,
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
        ? `已检测到程序，仍缺：${missing.join('、')}。可再点「一键安装」补齐。`
        : '本地语音安装已就绪',
    }
  }

  async function install(input, { onProgress, signal } = {}) {
    const config = normalizeLocalVoiceConfig({
      ...store.load(),
      ...input,
      installRoot: (input?.installRoot || store.load().installRoot || defaultLocalVoiceInstallRoot()),
    })
    store.save(config)
    const result = await installLocalVoice(config, { onProgress, signal, env })
    const saved = store.save({ ...config, installRoot: result.installRoot })
    const verified = verifyInstall(saved)
    return {
      ...verified,
      ...result,
      config: saved,
    }
  }

  return {
    inspect,
    status,
    start,
    stop,
    verifyInstall,
    install,
    save: input => store.save(input),
    load: () => store.load(),
  }
}
