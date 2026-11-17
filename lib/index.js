/**
 * dsh-chatbot-tools — 补齐 DeepSeek Chatbot 有、DSH 缺的能力：
 *   1. 模型内容安全（safety_check，官方请求顶层字段，经 deepseekLlmApiExtensions 注入）
 *   2. 图片搜索（Search API 不支持，只能走服务端工具 deepseek_web_search，需消息内带图）
 *   3. 结构化引用来源（Search API 的 site_name/site_icon/date/authority）
 *   4. 文档识别 OCR / 语音识别 ASR / 语音合成 TTS（官方工具 API）
 *
 * 设计约束（源码证据见 docs/incident-*.md）：
 *   - 主对话不能声明服务端联网工具：dsh-llm-deepseek 的 translate.startBlock 对未知块抛
 *     UNSUPPORTED_CONTENT（src/translate.ts:60），且 extension 合并拒绝覆盖 base 的 tools 字段。
 *     因此图片搜索走"辅助 Messages 调用"，与会话主链路解耦。
 *   - safety_check 有三条服务端硬约束：与 defer_loading 互斥、非思考模式与 client tools 互斥、
 *     内部 title 请求不需要。守卫见 lib/safety.js。
 *   - 拒答（stop_reason: refusal）会让适配器抛 unsupported stop reason，用 llm/stream 兜底。
 *   - 凭证优先复用 DeepSeek 账号登录（x-dsh-auth-token），回退 DEEPSEEK_API_KEY 或字面 apiKey。
 *
 * 设置页：Config 每个字段都标 .volatile()，含义是宿主把改动写进运行中的引用（改完立即生效，
 * 不需要重载插件）。**注意 .volatile() 不会自动生成表单**：插件页的配置 UI 必须由 client.js
 * 注册进 `plugins.bundle.config` / `plugins.row.config` 槽位，见 client.js 顶部注释。
 * 因此请求期一律走 live() 现读，改设置不需要重载插件。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path, { extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { deferredToolNames, refusalGuardStream, safetyDecision } from './safety.js'
import { purposeFormatError, uploadFailureHint } from './files.js'
import { createDeepSeekSpeechProvider } from './speech.js'
import { applyTerms, parseTermMap, toSpeakable } from './speakable.js'

export const name = 'dsh-chatbot-tools'
export const inject = ['tools']

/** 构建标记：每次改动递增，用来在日志里确认 hotreload 真的换上了新代码。 */
const BUILD_TAG = 'r23-refusal-finish'

/** cosmokit 给 volatile 配置引用打的标记；值在运行时会被包成 { get() } 的活引用。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 默认配置；设置页写入的覆盖会合到它上面。 */
const DEFAULTS = {
  // 平台 API Key。Search / OCR 接受账号登录，但 TTS / ASR 只认 API Key（实测 401），
  // 所以需要语音能力时必须提供它（设置页填写或 DEEPSEEK_API_KEY 环境变量）。
  apiKey: '',
  /** 宿主凭据服务里的 key 名；默认与 DSH 的 DeepSeek 适配器一致。 */
  apiKeyRef: 'DEEPSEEK_API_KEY',
  apiBaseURL: 'https://api.deepseek.com',
  messagesBaseURL: 'https://api.deepseek.com/anthropic/v1',
  apiVersion: '2023-06-01',
  model: 'deepseek-flash',
  maxTokens: 1024,
  maxUses: 1,
  serverTool: 'deepseek_web_search',
  searchCount: 8,
  maxImageBytes: 4 * 1024 * 1024,
  // 内容安全**默认关闭**：safety_check 会让服务端对整条请求做内容审核，从而限制 DSH
  // 本身的能力（网安红队/渗透测试这类正常需求会被拒答）。是否牺牲这部分能力由用户决定。
  safetyEnabled: false,
  safetyMode: 'enforce',
  safetyLevel: 'high',
  safetyGuardDeferLoading: true,
  safetyLog: true,
  safetySkipPurposes: ['title', 'session-title'],
  // 拒答提示**默认关闭**：DSH 适配器对 refusal 的原始报错会原样透出（不改变 DSH 行为）。
  // 开启后才拦截 refusal，换成一段可读提示 + 正常收尾。
  refusalNotice: false,
  ocrPurpose: 'text_recognition',
  ocrMaxChars: 8000,
  ttsVoice: 'stella',
  ttsFormat: 'wav',
  ttsOutDir: '',
  ttsMaxChars: 10000,
  ttsFilterMarkdown: false,
  // skip 删除代码块 / placeholder 念一句占位 / read 保留代码内容
  ttsCodeMode: 'skip',
  // 术语替换表：官方 TTS 无语种/prompt 参数，英文词易被误判，这里做朗读前替换
  ttsTermMap: '',
  // Files API 默认解析方式（见 guides/document_parsing）
  documentPurpose: 'text_recognition',
}

/**
 * 设置页 schema。每个字段都标 `.volatile()` —— 设置服务只用 volatile 节点建表单，
 * 一个标记都没有的 schema 会**静默地不生成任何表单**。volatile 同时意味着宿主把改动
 * 直接写进运行中的引用（不重载插件），所以请求期必须用 live() 现读。
 */
export const Config = z.object({
  apiKey: z.string().default('').volatile()
    .description('平台 API Key（TTS/ASR 必需；Search/OCR 可用账号登录）。明文存 profile patch，建议改用 DEEPSEEK_API_KEY'),
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY').volatile()
    .description('宿主凭据服务里的 key 名（默认与 DSH 的 DeepSeek 适配器一致）'),
  safetyEnabled: z.boolean().default(false).volatile()
    .description('内容安全总开关（默认关闭）。关闭时完全不注入 safety_check，DSH 能力不受任何限制'),
  safetyMode: z.union([z.const('off'), z.const('observe'), z.const('enforce')]).default('enforce').volatile()
    .description('总开关打开后的模式：off 仍关闭 / observe 只记录不注入 / enforce 注入 safety_check'),
  safetyLevel: z.union([z.const('high'), z.const('low')]).default('high').volatile()
    .description('内容安全级别：high 基础风控 / low 等同不传'),
  safetyGuardDeferLoading: z.boolean().default(true).volatile()
    .description('请求带 defer_loading 时跳过注入（事故守卫，务必保持开启）'),
  safetyLog: z.boolean().default(true).volatile()
    .description('把每次请求的工具形态记到 ~/.dsh/logs/chatbot-tools-safety.ndjson'),
  safetySkipPurposes: z.array(z.string()).default(['title', 'session-title']).volatile()
    .description('这些内部请求不注入 safety_check，省费用'),
  refusalNotice: z.boolean().default(false).volatile()
    .description('拒答提示（默认关闭）。关闭时 refusal 保持 DSH 原始行为；开启后才把抛错换成可读提示'),
  model: z.string().default('deepseek-flash').volatile()
    .description('辅助调用（图片搜索 / 结构化搜索 / OCR 之外的模型调用）使用的模型'),
  serverTool: z.string().default('deepseek_web_search').volatile()
    .description('图片搜索使用的服务端工具名'),
  maxUses: z.number().step(1).min(1).default(1).volatile()
    .description('单次图片搜索的服务端工具调用上限'),
  maxTokens: z.number().step(1).min(16).default(1024).volatile()
    .description('辅助调用的输出上限'),
  maxImageBytes: z.number().step(1).min(1024).default(4194304).volatile()
    .description('图片搜索的图片大小上限（字节）'),
  apiBaseURL: z.string().default('https://api.deepseek.com').volatile()
    .description('工具 API 基址（/v1/tools/*）'),
  messagesBaseURL: z.string().default('https://api.deepseek.com/anthropic/v1').volatile()
    .description('Anthropic 兼容 Messages 基址（图片搜索用）'),
  searchCount: z.number().step(1).min(1).max(50).default(8).volatile()
    .description('chatbot_search 默认返回条数'),
  ocrPurpose: z.union([z.const('text_recognition'), z.const('rich_layout_recognition')]).default('text_recognition').volatile()
    .description('OCR 模式：纯文本提取 / 逐页版面识别'),
  ocrMaxChars: z.number().step(1).min(200).default(8000).volatile()
    .description('OCR 结果返回给模型的字符上限'),
  documentPurpose: z.union([z.const('text_recognition'), z.const('rich_layout_recognition'), z.const('user_data')])
    .default('text_recognition').volatile()
    .description('chatbot_upload_document 默认的解析方式。text_recognition 只要文字（按页计费）/ '
      + 'rich_layout_recognition 文字+文中图表（按页计费）/ user_data 不解析不计费（纯文本、表格、电子书）'),
  ttsVoice: z.union([z.const('stella'), z.const('tide')]).default('stella').volatile()
    .description('朗读音色：stella 海星（女声）/ tide 暗潮（男声）'),
  ttsFormat: z.union([z.const('wav'), z.const('pcm')]).default('wav').volatile()
    .description('朗读输出格式'),
  ttsOutDir: z.string().default('').volatile()
    .description('朗读文件输出目录，留空用 ~/.dsh/chatbot-tools/out'),
  ttsMaxChars: z.number().step(1).min(1).max(10000).default(10000).volatile()
    .description('单次朗读的字符上限（服务端上限 10000）'),
  ttsFilterMarkdown: z.boolean().default(false).volatile()
    .description('朗读前由服务端去掉 Markdown。默认 false：插件已自己把 Markdown 转成可朗读文本'
      + '（行内代码保留，避免像 ttsFilterMarkdown 这样的词被吞掉）'),
  ttsCodeMode: z.union([z.const('skip'), z.const('placeholder'), z.const('read')]).default('skip').volatile()
    .description('代码块怎么处理：skip 删除 / placeholder 念一句「这里有一段代码」/ read 保留内容'),
  ttsTermMap: z.string().default('').volatile()
    .description('朗读前的术语替换表。JSON 或 key=value 形式，例如 {"Markdown":"马克当","API":"接口"}。'
      + '官方 TTS 无语种/prompt 参数，英文词在中文里可能被读错，用这里换成读音稳定的说法'),
})

const MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 拆开 volatile 引用，拿到真实值。 */
function plainValue(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && typeof value.get === 'function') {
    return plainValue(value.get())
  }
  return value
}

/** 把整个 config 物化成普通对象（一层）。 */
function plainConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) out[key] = plainValue(value)
  return out
}

/** 现读配置：设置页改完立刻生效，不需要重载。 */
function settings(config) {
  return { ...DEFAULTS, ...plainConfig(config) }
}

/** 解析一次请求的鉴权头：显式设置 > 环境变量 > 宿主凭据服务 > DeepSeek 账号登录。 */
async function authHeaders(ctx, cfg, endpoint) {
  const explicit = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : ''
  const env = (process.env.DEEPSEEK_API_KEY ?? '').trim()
  let key = explicit.length > 0 ? explicit : env
  let source = explicit.length > 0 ? 'settings' : env.length > 0 ? 'env' : ''
  if (key.length === 0) {
    // 宿主凭据服务是权威来源（DSH 设置里填过的 API Key 就存这里），
    // 走与官方适配器同一条路径：ctx.get('credentials').resolve(ref)。
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      const ref = typeof cfg.apiKeyRef === 'string' && cfg.apiKeyRef.trim().length > 0 ? cfg.apiKeyRef.trim() : 'DEEPSEEK_API_KEY'
      try {
        const hit = await credentials.resolve(ref)
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          key = hit.value
          source = `credentials:${ref}`
        }
      } catch {
        /* 凭据服务不可用则继续走账号通道 */
      }
    }
  }
  if (key.length > 0) {
    return { kind: 'api-key', source, headers: { 'x-api-key': key, authorization: `Bearer ${key}` } }
  }
  const account = ctx.get('deepseekAccount')
  if (account && typeof account.resolveToken === 'function') {
    let token
    try {
      token = await account.resolveToken(endpoint)
    } catch {
      token = undefined
    }
    if (typeof token === 'string' && token.length > 0) {
      // 同一账号 token 双发：Search/OCR 认 x-dsh-auth-token；TTS/ASR 实测仍 401（只认平台 Key）。
      return { kind: 'account', headers: { 'x-dsh-auth-token': token, authorization: `Bearer ${token}` } }
    }
  }
  throw new Error(
    '没有可用的 DeepSeek 凭证：TTS/ASR 需要平台 API Key —— 在 DSH 设置里配置 API Key、在插件设置里填 apiKey，'
    + '或设置 DEEPSEEK_API_KEY 环境变量；Search/OCR 可直接用应用内 DeepSeek 账号登录。',
  )
}

/** 401 时给出可行动的说明（账号 token 在部分工具 API 上不被接受）。 */
function authHint(result, auth) {
  if (result.status === 401 && auth.kind === 'account') {
    return '（账号登录在 TTS/ASR 上不被接受：请在插件设置里填 apiKey，或设置 DEEPSEEK_API_KEY）'
  }
  return ''
}

/** 发送一次 JSON POST，返回 { status, ok, body, raw }。 */
async function postJSON(url, headers, body, timeoutMs = 60000) {
  return send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, timeoutMs)
}

/** 发送一次 multipart POST（FormData 自带 boundary，不要手写 content-type）。 */
async function postForm(url, headers, form, timeoutMs = 180000) {
  return send(url, { method: 'POST', headers, body: form }, timeoutMs)
}

/** 统一 fetch：超时、错误说明、JSON 解析。 */
async function send(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, { redirect: 'error', ...init, signal: controller.signal })
  } catch (error) {
    throw new Error(`请求 ${url} 失败：${String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  let body
  try {
    body = buffer.length > 0 ? JSON.parse(buffer.toString('utf8')) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, ok: response.ok, body, buffer, contentType: response.headers.get('content-type') ?? '' }
}

/** 从 Anthropic / OpenAI 兼容错误体里取一句可读信息。 */
function apiDetail(result) {
  const body = result.body
  if (body && typeof body === 'object') {
    const error = body.error
    if (typeof error === 'string' && error.length > 0) return error
    if (error && typeof error.message === 'string') return error.message
    if (typeof body.message === 'string') return body.message
  }
  const text = result.buffer.toString('utf8').slice(0, 300)
  return text.length > 0 ? text : `HTTP ${result.status}`
}

/** 追加一行结构化事件到观测日志（失败不影响插件）。 */
function logEvent(event) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      path.join(dir, 'chatbot-tools-safety.ndjson'),
      JSON.stringify({ ts: new Date().toISOString(), event }) + '\n',
    )
  } catch {
    /* 观测失败不影响插件 */
  }
}

/** 观测模式：只记工具形态，不记录消息内容。 */
function logSafetyObservation(request, decision) {
  try {
    const deferred = deferredToolNames(request)
    const tools = Array.isArray(request.body?.tools) ? request.body.tools : []
    // 四个互斥顶层字段谁在场：用来区分「是 DSH 自己注入的」还是「本插件注入的」。
    // safety_check 在这一行里出现，说明进入 prepare 前 body 里已经有了（本插件是在之后才加的）。
    const serverFields = ['deepseek_web_search', 'deepseek_read_url', 'safety_check', 'title']
      .filter(name => request.body != null && Object.prototype.hasOwnProperty.call(request.body, name))
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      purpose: request.purpose ?? null,
      thinking: request.body?.thinking?.type ?? null,
      toolCount: tools.length,
      deferredCount: deferred.length,
      deferredNames: deferred,
      serverFields,
      nonTextResults: decision.nonTextResults ?? 0,
      decision: decision.reason,
    })
    const dir = path.join(os.homedir(), '.dsh', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'chatbot-tools-safety.ndjson'), line + '\n')
  } catch {
    /* 观测失败不影响请求 */
  }
}

/** 把 image_search 结果块转成 markdown 列表。 */
function renderImageResults(blocks) {
  const lines = []
  const searches = blocks.filter(block => block && block.type === 'server_tool_use' && block.kind === 'image_search')
  for (const block of blocks) {
    if (!block || block.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (!item || typeof item.url !== 'string') continue
      const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : '(无标题)'
      const image = typeof item.image_url === 'string' && item.image_url.length > 0 ? item.image_url : undefined
      lines.push(image ? `- ![${title}](${image}) — 来源页：${item.url}` : `- ${title} — ${item.url}`)
    }
  }
  const header = `图片搜索完成（服务端调用 ${searches.length} 次）`
  return lines.length > 0
    ? `${header}，结果 ${lines.length} 条：\n${lines.join('\n')}`
    : `${header}，但没有取到图片结果。可换一张更清晰的图或补一句 query 重试。`
}

/** 把 Search API 结果转成结构化 markdown（带站点/时间/权威度）。 */
function renderSources(results) {
  return results.map((item, index) => {
    const meta = [item.site_name, item.date, typeof item.authority === 'number' ? `权威度 ${item.authority}` : undefined]
      .filter(part => typeof part === 'string' && part.length > 0)
      .join(' · ')
    const summary = typeof item.summary === 'string' && item.summary.length > 0 ? item.summary : item.snippet
    return `${index + 1}. [${item.title || item.url}](${item.url})${meta ? ` — ${meta}` : ''}\n   ${summary ?? ''}`
  }).join('\n')
}


/** 从会话日志里取出某条 assistant 消息的正文（供 TTS 路由使用）。 */
function messageText(ctx, sessionId, messageId) {
  if (!sessionId || !messageId) return ''
  const session = ctx.get('agents')?.get(sessionId)?.session
  if (!session) return ''
  let events = []
  try {
    events = session.snapshotEvents()
  } catch {
    return ''
  }
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue
    const message = event.data?.message
    if (!message || String(message.id) !== String(messageId)) continue
    return (message.content ?? [])
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n\n')
  }
  return ''
}

export function apply(ctx, config) {
  // 请求期一律现读：设置页的 volatile 改动直接写进运行中的引用。
  const live = () => settings(config)
  logEvent(`applied:${BUILD_TAG}:safety=${live().safetyEnabled ? live().safetyMode : 'off(default)'}:refusal=${live().refusalNotice}`)

  // ── 0. 拒答兜底：最先注册 ──────────────────────────────────────────────────
  // **顺序是有意义的**：这段原来排在两个 `ctx.inject`（可选服务）之后，
  // 实测在 headless profile 里（没有 speechToText 服务）apply 会在那个 inject 处中断，
  // 导致本段与后面所有工具注册全部没执行——表现为拒答提示静默失效、工具也消失。
  // 所以：无条件注册的放最前面，可选服务各自隔离，任何一步失败都不许影响后续。
  ctx.on('llm/stream', function (_options, next) {
    // `next()` 必须在这里**同步**调用：waterfall 要求 handler 执行期间就取得下游流。
    return refusalGuardStream(next(), live().refusalNotice)
  })

  /** 可选服务：缺失或注册失败都不应中断 apply。 */
  const optional = (label, register) => {
    try {
      register()
    } catch (error) {
      logEvent(`optional-failed:${label}:${error && error.message ? error.message : String(error)}`)
    }
  }

  // ── 1. 内容安全：给官方 DeepSeek 请求加顶层 safety_check ─────────────────────
  // 注册常驻，开关交给 prepare 现读 safetyMode，改设置无需重载。
  optional('safety', () => ctx.inject(['deepseekLlmApiExtensions'], child => {
    child.effect(() => child.deepseekLlmApiExtensions.register('safety_check', {
      prepare(request) {
        const cfg = live()
        const decision = safetyDecision(request, cfg)
        if (cfg.safetyLog) logSafetyObservation(request, decision)
        if (!decision.inject) return undefined
        return { value: { level: cfg.safetyLevel } }
      },
    }), 'dsh-chatbot-tools: safety_check')
  }))

  // ── 1.5 语音输入：把 DeepSeek ASR 注册为官方 speechToText provider ───────────
  // 官方客户端 UI（dsh-experimental-client-ui-voice-input）会列出它并在录音后调用它。
  optional('speech', () => ctx.inject(['speechToText'], child => {
    child.effect(() => child.speechToText.register(createDeepSeekSpeechProvider({
      config: live,
      auth: endpoint => authHeaders(ctx, live(), endpoint),
      postForm,
      detail: apiDetail,
    })), 'dsh-chatbot-tools: deepseek-asr provider')
  }))

  // ── 3. 图片搜索工具 ────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_image_search',
    description: '按图片搜索相似图片与出处（DeepSeek 服务端图片搜索）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地图片的绝对路径（png/jpg/webp/gif）' },
      query: { type: 'string', description: '可选：补充搜索意图，越具体越好' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const ext = extname(String(args.path)).toLowerCase()
      const mediaType = MEDIA[ext]
      if (!mediaType) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}；支持 png/jpg/jpeg/webp/gif`)
      const bytes = await readFile(args.path)
      if (bytes.length > cfg.maxImageBytes) {
        throw new Error(`图片过大：${bytes.length} 字节，上限 ${cfg.maxImageBytes}；请先压缩。`)
      }
      const endpoint = `${cfg.messagesBaseURL}/messages`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const hint = typeof args.query === 'string' && args.query.length > 0
        ? `用这张图片做图片搜索。补充意图：${args.query}`
        : '用这张图片做图片搜索，找出相似图片与原始出处。'
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        thinking: { type: 'disabled' },
        tools: [{ type: cfg.serverTool, name: cfg.serverTool, max_uses: cfg.maxUses }],
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
            { type: 'text', text: hint },
          ],
        }],
      }
      const result = await postJSON(endpoint, { ...auth.headers, 'anthropic-version': cfg.apiVersion }, body)
      if (!result.ok) throw new Error(`图片搜索失败（HTTP ${result.status}，凭证 ${auth.kind}）：${apiDetail(result)}`)
      const blocks = result.body && Array.isArray(result.body.content) ? result.body.content : []
      return renderImageResults(blocks)
    },
  })), 'dsh-chatbot-tools: chatbot_image_search')

  // ── 4. 结构化搜索（Search API）────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_search',
    description: '联网搜索并返回带站点、发布时间、权威度的结构化来源，便于正文引用。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词，支持 site:/after:/lang: 等语法' },
      count: { type: 'number', description: '返回条数 1-50，默认取设置里的 searchCount' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const endpoint = `${cfg.apiBaseURL}/v1/tools/search`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const count = Number.isFinite(args.count) ? Math.min(50, Math.max(1, Math.trunc(args.count))) : cfg.searchCount
      const result = await postJSON(endpoint, auth.headers, { query: String(args.query), count, need_content: false })
      if (!result.ok) throw new Error(`搜索失败（HTTP ${result.status}，凭证 ${auth.kind}）：${apiDetail(result)}`)
      const results = result.body && Array.isArray(result.body.results) ? result.body.results : []
      if (results.length === 0) return '没有搜到结果。换关键词，或用 site:/after: 语法收窄范围后重试。'
      return `共 ${results.length} 条来源（引用时请保留完整 URL）：\n${renderSources(results)}`
    },
  })), 'dsh-chatbot-tools: chatbot_search')

  // ── 5. OCR：文档/图片文字识别 ───────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_ocr',
    description: '识别 PDF/Word/PPT/图片中的文字，按页返回（DeepSeek OCR 工具 API）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地文件绝对路径（pdf/docx/pptx/png/jpg 等）' },
      purpose: {
        type: 'string',
        description: 'text_recognition（默认，纯文本优先）或 rich_layout_recognition（逐页版面）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const endpoint = `${cfg.apiBaseURL}/v1/tools/ocr`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const bytes = await readFile(args.path)
      const form = new FormData()
      form.append('file', new Blob([bytes]), path.basename(String(args.path)))
      form.append('purpose', typeof args.purpose === 'string' && args.purpose.length > 0 ? args.purpose : cfg.ocrPurpose)
      const result = await postForm(endpoint, auth.headers, form)
      if (!result.ok) throw new Error(`OCR 失败（HTTP ${result.status}，凭证 ${auth.kind}）：${apiDetail(result)}`)
      const body = result.body ?? {}
      if (body.error) throw new Error(`OCR 失败：${body.error.message ?? JSON.stringify(body.error)}`)
      const pages = Array.isArray(body.pages) ? body.pages : []
      if (pages.length === 0) return 'OCR 没有返回任何页。'
      const chunks = []
      let total = 0
      for (const page of pages) {
        const text = typeof page.text === 'string' ? page.text.trim() : ''
        if (text.length === 0) continue
        const piece = `--- 第 ${Number(page.index) + 1} 页${page.finish_reason === 'length' ? '（已截断）' : ''} ---\n${text}`
        if (total + piece.length > cfg.ocrMaxChars) {
          chunks.push(piece.slice(0, Math.max(0, cfg.ocrMaxChars - total)))
          chunks.push(`（已到返回上限 ${cfg.ocrMaxChars} 字符，其余 ${pages.length} 页未展开）`)
          break
        }
        chunks.push(piece)
        total += piece.length
      }
      return `OCR 完成：${body.page_count ?? pages.length} 页，用途 ${body.purpose ?? cfg.ocrPurpose}。\n${chunks.join('\n\n')}`
    },
  })), 'dsh-chatbot-tools: chatbot_ocr')

  // ── 5.5 文件上传：Files API 换取 file_id（对应 Chatbot 的「文件输入」）──────────
  // 与 OCR 的区别：OCR 把文字**取回来**进本地上下文；这里是把文件**交给服务端**解析，
  // 之后由模型按 file_id 直接读（聊天请求里带
  // {"type":"document","source":{"type":"file","file_id":"file-api-..."}}）。
  // 官方文档：guides/document_parsing。契约要点：
  //   - POST {base}/files，multipart；**purpose 字段必须排在 file 之前**，否则 400
  //   - text_recognition / rich_layout_recognition 会解析并**按页计费**（图表另有差别）
  //   - user_data 不解析、不计费（纯文本/表格/电子书，原件 ≤32 MiB）
  //   - 解析类的上限：单文件 100 MiB / 1000 页 / 上传 120s / 解析 120s / 并发 15
  //   - 返回的是 id（形如 file-api-xxxx），原始文件与解析结果都不可下载
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_upload_document',
    description: '把本地文档/图片上传到 DeepSeek Files API，返回可被对话引用的 file_id（可选解析方式）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地文件绝对路径（pdf/docx/pptx/xlsx/txt/md/图片等）' },
      purpose: {
        type: 'string',
        description: 'text_recognition（默认，只要文字）/ rich_layout_recognition（文字+文中图表）/ user_data（不解析、不计费，纯文本表格电子书）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const endpoint = `${cfg.apiBaseURL}/files`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const purpose = typeof args.purpose === 'string' && args.purpose.length > 0 ? args.purpose : cfg.documentPurpose
      const allowed = ['text_recognition', 'rich_layout_recognition', 'user_data']
      if (!allowed.includes(purpose)) {
        throw new Error(`不支持的 purpose：${purpose}；只能是 ${allowed.join(' / ')}`)
      }
      // 前置拦截「用途 × 格式」冲突：解析类用途不收纯文本，服务端只会回一句
      // 含义不清的 format is not supported。实测矩阵见 lib/files.js。
      const mismatch = purposeFormatError(String(args.path), purpose)
      if (mismatch) throw new Error(mismatch)
      const bytes = await readFile(args.path)
      // user_data 的 32 MiB 是「原始文件」限制；解析类按 100 MiB 判定。
      const limit = purpose === 'user_data' ? 32 * 1024 * 1024 : 100 * 1024 * 1024
      if (bytes.length > limit) {
        throw new Error(`文件过大：${bytes.length} 字节，purpose=${purpose} 上限 ${limit} 字节。`)
      }
      const form = new FormData()
      form.append('purpose', purpose) // 顺序有意义：必须在 file 之前
      form.append('file', new Blob([bytes]), path.basename(String(args.path)))
      // 上传 120s + 解析 120s，留余量；默认 180s 可能不够。
      const result = await postForm(endpoint, auth.headers, form, 260000)
      if (!result.ok) {
        const detail = apiDetail(result)
        throw new Error(`上传失败（HTTP ${result.status}，凭证 ${auth.kind}）：${detail}${uploadFailureHint(result.status, detail)}`)
      }
      const body = result.body ?? {}
      if (body.error) throw new Error(`上传失败：${body.error.message ?? JSON.stringify(body.error)}`)
      const fileId = typeof body.id === 'string' ? body.id : ''
      if (fileId.length === 0) throw new Error(`上传响应里没有 id：${JSON.stringify(body).slice(0, 300)}`)
      return [
        `上传完成：${fileId}`,
        `文件名：${body.filename ?? path.basename(String(args.path))}；用途：${body.purpose ?? purpose}；大小：${body.bytes ?? bytes.length} 字节`,
        purpose === 'user_data'
          ? '（未解析、未计费；内容在对话引用时由服务端转换后进入上下文。）'
          : '（已按页计费解析完成；文中图表仅在 rich_layout_recognition 下可见。）',
        `引用方式：{"type":"document","source":{"type":"file","file_id":"${fileId}"}}；Messages 协议还需请求头 anthropic-beta: files-api-2025-04-14。`,
      ].join('\n')
    },
  })), 'dsh-chatbot-tools: chatbot_upload_document')

  // ── 6. ASR：音频转文字 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_asr',
    description: '把本地音频转写为文字（16-bit PCM WAV 或 Ogg Opus，≤120 秒，≤8 MiB）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地音频绝对路径（wav / ogg）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const endpoint = `${cfg.apiBaseURL}/v1/tools/asr`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const bytes = await readFile(args.path)
      if (bytes.length > 8 * 1024 * 1024) throw new Error(`音频过大：${bytes.length} 字节，上限 8 MiB。`)
      const form = new FormData()
      form.append('file', new Blob([bytes]), path.basename(String(args.path)))
      const result = await postForm(endpoint, auth.headers, form)
      if (!result.ok) throw new Error(`ASR 失败（HTTP ${result.status}，凭证 ${auth.kind}）：${apiDetail(result)}${authHint(result, auth)}`)
      const text = typeof result.body?.text === 'string' ? result.body.text : ''
      const ms = Number.isFinite(result.body?.duration_ms) ? result.body.duration_ms : undefined
      if (text.length === 0) return `没有识别出文字${ms !== undefined ? `（音频 ${ms} ms）` : ''}。`
      return `转写结果${ms !== undefined ? `（音频 ${ms} ms）` : ''}：\n${text}`
    },
  })), 'dsh-chatbot-tools: chatbot_asr')

  // ── 7. TTS：文字转语音，落盘返回路径 ───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_tts',
    description: '把文本合成为语音文件并返回落盘路径（DeepSeek TTS 工具 API）。',
    parameters: {
      text: { type: 'string', required: true, description: '要朗读的文本，最多 10000 个计费字符' },
      voice: { type: 'string', description: 'stella（女声，默认）或 tide（男声）' },
      format: { type: 'string', description: 'wav（默认）或 pcm' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      // 本地把 Markdown 转成可朗读文本：行内代码必须保留（服务端会剥掉），代码块按 ttsCodeMode 处理。
      const spoken = applyTerms(
        toSpeakable(String(args.text ?? ''), { codeMode: cfg.ttsCodeMode }),
        parseTermMap(cfg.ttsTermMap),
      ).slice(0, cfg.ttsMaxChars)
      if (spoken.trim().length === 0) throw new Error('没有可朗读的文本。')
      const voice = typeof args.voice === 'string' && args.voice.length > 0 ? args.voice : cfg.ttsVoice
      const format = typeof args.format === 'string' && args.format.length > 0 ? args.format : cfg.ttsFormat
      const endpoint = `${cfg.apiBaseURL}/v1/tools/tts`
      const auth = await authHeaders(ctx, cfg, endpoint)
      const result = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth.headers },
        body: JSON.stringify({ text: spoken, voice_id: voice, format, filter_markdown: cfg.ttsFilterMarkdown }),
      }, 120000)
      if (!result.ok) throw new Error(`TTS 失败（HTTP ${result.status}，凭证 ${auth.kind}）：${apiDetail(result)}${authHint(result, auth)}`)
      if (result.buffer.length === 0) throw new Error('TTS 返回了空音频。')
      const dir = cfg.ttsOutDir && cfg.ttsOutDir.length > 0
        ? cfg.ttsOutDir
        : path.join(os.homedir(), '.dsh', 'chatbot-tools', 'out')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `tts-${Date.now()}.${format === 'pcm' ? 'pcm' : 'wav'}`)
      await writeFile(file, result.buffer)
      return `已生成语音：${file}（${voice}，${format}，${result.buffer.length} 字节，朗读 ${spoken.length} 字符）`
    },
  })), 'dsh-chatbot-tools: chatbot_tts')

  // ── 7.5 TTS 界面路由：客户端朗读按钮只发 sessionId + messageId ─────────────
  optional('web', () => ctx.inject(['webServer'], child => {
    child.effect(() => child.webServer.register({
      path: '/chatbot-voice/tts',
      kind: 'exact',
      resource: async request => {
        const startedAt = Date.now()
        try {
          const url = new URL(request.url, 'http://local')
          const text = messageText(
            ctx,
            url.searchParams.get('sessionId') ?? '',
            url.searchParams.get('messageId') ?? '',
          )
          if (text.trim().length === 0) return new Response('未找到该消息的正文', { status: 404 })
          const cfg = live()
          const spoken = applyTerms(
            toSpeakable(text, { codeMode: cfg.ttsCodeMode }),
            parseTermMap(cfg.ttsTermMap),
          ).slice(0, cfg.ttsMaxChars)
          const endpoint = `${cfg.apiBaseURL}/v1/tools/tts`
          const auth = await authHeaders(ctx, cfg, endpoint)
          const result = await send(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth.headers },
            body: JSON.stringify({
              text: spoken,
              voice_id: cfg.ttsVoice,
              format: cfg.ttsFormat,
              filter_markdown: cfg.ttsFilterMarkdown,
            }),
          }, 120000)
          if (!result.ok) {
            logEvent(`tts-failed:http=${result.status}`)
            return new Response(`TTS 失败：${apiDetail(result)}${authHint(result, auth)}`, { status: 502 })
          }
          // 审计：谁点了朗读、合成了多少字符、多大音频、耗时多久。
          logEvent(`tts-ok:chars=${spoken.length}:bytes=${result.buffer.length}:ms=${Date.now() - startedAt}`)
          return new Response(result.buffer, {
            headers: {
              'content-type': cfg.ttsFormat === 'pcm' ? 'audio/pcm' : 'audio/wav',
              'cache-control': 'no-store',
            },
          })
        } catch (error) {
          return new Response(String(error && error.message ? error.message : error), { status: 500 })
        }
      },
    }), 'dsh-chatbot-tools: /chatbot-voice/tts')
  }))

  // ── 8. 自检：凭证通道 + safety_check 兼容性 ────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chatbot_doctor',
    description: '自检插件：报告凭证通道，并验证 safety_check 与普通工具能否共存。',
    parameters: {
      live: { type: 'boolean', description: '为 true 时发起真实请求（会产生少量费用）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const cfg = live()
      const lines = [
        `- 构建：${BUILD_TAG}`,
        `- 设置：safetyEnabled=${cfg.safetyEnabled} mode=${cfg.safetyMode} level=${cfg.safetyLevel} guard=${cfg.safetyGuardDeferLoading} refusalNotice=${cfg.refusalNotice} model=${cfg.model}`,
      ]
      const initiator = ctx.get('agents')?.currentInitiator?.()
      const requestContext = initiator?.session?.requestContext?.()
      lines.push(`- 会话 provider：${requestContext?.provider ?? '(未知)'}；model：${requestContext?.model ?? '(未知)'}`)
      const stt = ctx.get('speechToText')
      lines.push(`- 语音输入提供方：${stt ? (stt.listProviders().map(p => p.id).join(', ') || '(无)') : '(speechToText 未挂载)'}`)
      const endpoint = `${cfg.messagesBaseURL}/messages`
      let auth
      try {
        auth = await authHeaders(ctx, cfg, endpoint)
        lines.push(`- 凭证通道：${auth.kind}${auth.source ? "/" + auth.source : ""}`)
      } catch (error) {
        lines.push(`- 凭证通道：不可用（${String(error && error.message ? error.message : error)}）`)
        return lines.join('\n')
      }
      if (!args.live) {
        lines.push('- safety_check 探测：跳过（live=false）')
        return lines.join('\n')
      }
      const makeBody = thinkingType => ({
        model: cfg.model,
        max_tokens: 16,
        thinking: { type: thinkingType },
        safety_check: { level: cfg.safetyLevel },
        tools: [{ name: 'dsh_ping', description: 'ping', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '回答一个字：好' }] }],
      })
      // 两种思考模式各打一次：服务端对「client tools + safety_check」的要求随思考模式而变。
      for (const thinkingType of ['enabled', 'disabled']) {
        try {
          const result = await postJSON(
            endpoint,
            { ...auth.headers, 'anthropic-version': cfg.apiVersion },
            makeBody(thinkingType),
          )
          lines.push(
            `- thinking=${thinkingType} + safety_check + function tool：HTTP ${result.status}`
            + (result.ok ? '（接受）' : `（拒绝：${apiDetail(result)}）`),
          )
        } catch (error) {
          lines.push(`- thinking=${thinkingType} 探测失败：${String(error && error.message ? error.message : error)}`)
        }
      }
      return lines.join('\n')
    },
  })), 'dsh-chatbot-tools: chatbot_doctor')
}
