/**
 * DeepSeek ASR provider for the official speech-to-text seam.
 *
 * 官方语音输入由三层组成：
 *   @deepseek-ai/dsh-experimental-speech-to-text        （服务 + provider 注册表）
 *   @deepseek-ai/dsh-experimental-api-speech-to-text    （Remote 控制器，客户端调用它）
 *   @deepseek-ai/dsh-experimental-client-ui-voice-input （麦克风 UI）
 * 因此把 DeepSeek 的 /v1/tools/asr 包成一个 SpeechProvider 注册进去，
 * 官方麦克风按钮就能直接列出并使用它，不需要自己写录音 UI。
 *
 * 这里只依赖 speechToText 的公开契约：
 *   { info, transcribe({ audio, language }, signal) -> { text, audioSeconds, inferenceSeconds } }
 */

/** DeepSeek ASR 支持的语种（见官方文档「语音识别 → 语种」）。 */
const ASR_LANGUAGES = [
  'auto', 'zh', 'yue', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'ru',
  'ar', 'hi', 'id', 'vi', 'th', 'tr', 'ms', 'fil', 'pl', 'hu',
]

/** 读 16-bit PCM WAV 的时长（秒）；格式不认识时返回 0。 */
export function wavSeconds(bytes) {
  try {
    if (bytes.length < 44) return 0
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF') return 0
    let byteRate = 0
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
      const size = view.getUint32(offset + 4, true)
      if (id === 'fmt ' && offset + 16 + 12 <= bytes.length) {
        byteRate = view.getUint32(offset + 16, true)
      } else if (id === 'data' && byteRate > 0) {
        return Math.min(size, bytes.length - offset - 8) / byteRate
      }
      offset += 8 + size + (size % 2)
    }
  } catch {
    /* 解析失败按 0 处理 */
  }
  return 0
}

/**
 * 建一个 DeepSeek ASR provider。
 *
 * @param {object} deps
 * @param {() => object} deps.config 现读配置（baseURL / apiKey 等）
 * @param {(endpoint: string) => Promise<{ kind: string, headers: Record<string,string> }>} deps.auth 鉴权头解析
 * @param {(url: string, headers: Record<string,string>, form: FormData, timeoutMs?: number) => Promise<{ ok: boolean, status: number, body?: any, buffer: Buffer }>} deps.postForm multipart POST
 * @param {(result: any) => string} deps.detail 错误详情提取
 * @returns {{ info: object, transcribe: Function }}
 */
export function createDeepSeekSpeechProvider({ config, auth, postForm, detail }) {
  return {
    info: {
      id: 'deepseek-asr',
      name: 'DeepSeek ASR（云端）',
      location: 'cloud',
      languages: ASR_LANGUAGES,
    },
    /**
     * @param {{ audio: Uint8Array, language: string }} input 一次完整录音（16-bit PCM WAV）
     * @param {AbortSignal} signal 取消
     * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number }>}
     */
    async transcribe(input, signal) {
      signal?.throwIfAborted?.()
      const cfg = config()
      const endpoint = `${cfg.apiBaseURL}/v1/tools/asr`
      const startedAt = Date.now()
      const credentials = await auth(endpoint)
      const bytes = Buffer.from(input.audio)
      if (bytes.length > 8 * 1024 * 1024) throw new Error(`录音过大：${bytes.length} 字节，ASR 上限 8 MiB`)
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'recording.wav')
      const result = await postForm(endpoint, credentials.headers, form, 120000)
      if (!result.ok) {
        throw new Error(`DeepSeek ASR 失败（HTTP ${result.status}）：${detail(result)}`)
      }
      const body = result.body ?? {}
      const text = typeof body.text === 'string' ? body.text : ''
      const audioSeconds = Number.isFinite(body.duration_ms)
        ? body.duration_ms / 1000
        : wavSeconds(input.audio)
      return {
        text,
        audioSeconds,
        inferenceSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
      }
    },
  }
}
