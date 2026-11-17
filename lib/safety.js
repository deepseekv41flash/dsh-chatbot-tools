/**
 * safety_check 注入判定（无外部依赖，便于离线测试）。
 *
 * 服务端规则：`defer_loading` 不得与 `deepseek_web_search`、`deepseek_read_url`、
 * `safety_check`、`title` 共存。2026-11-17 事故就是「safety_check 常开 + 会话内工具集增量」
 * 同时成立导致的 400，且因 developer/message 持久化而不可逆。
 * 复现与影响面见 docs/incident-2026-11-17-safety-check-defer-loading.md。
 *
 * 扩展契约里工具位于 request.body.tools（DeepSeekLlmApiExtensionRequest.body），
 * 不是 request.tools —— 文档示例里的写法是笔误，按契约实现。
 */

/**
 * 请求是否处于思考模式。
 *
 * 官方文档：思考模式默认打开（不传 thinking 即开启），`disabled` 才关闭。
 * 服务端另有一条未写进文档的约束：**非思考模式**下 client tools 不能与
 * `safety_check` / `deepseek_web_search` / `deepseek_read_url` / `title` 共存
 * （2026-11-17 实测：thinking disabled + safety_check + function tool → 400）。
 */
export function thinkingEnabled(body) {
  return body?.thinking?.type !== 'disabled'
}

/**
 * 请求里是否已有非纯文本的 `tool_result` 内容块（图片/文档）。
 *
 * 服务端第三条约束（2026-11-17 另一会话实测）：
 *   `messages.94: only text content is supported in `tool_result` blocks with
 *    `deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title` yet`
 * 也就是这四个顶层字段只要在场，tool_result 就只能是纯文本。`read_image`
 * 这类工具会把图片块塞进 tool_result，一旦它与 safety_check 同处一个请求就 400，
 * 而错误发生在「历史已被持久化」之后 —— 会话会像 defer_loading 事故一样被卡死。
 *
 * 该约束与 `defer_loading` 同族：都是服务端未文档化的互斥规则，只能由客户端让路。
 *
 * @param {{ body?: { messages?: unknown[] } }} request
 * @returns {number} 含非文本内容的 tool_result 块数量
 */
export function nonTextToolResults(request) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
  let count = 0
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue
      const inner = block.content
      if (!Array.isArray(inner)) continue
      if (inner.some(part => part && part.type !== 'text')) count++
    }
  }
  return count
}

/**
 * @param {{ purpose?: string, body?: { tools?: unknown[], thinking?: { type?: string } } }} request 扩展准备请求
 * @param {{ safetyMode?: string, safetyEnabled?: boolean, safetySkipPurposes?: string[], safetyGuardDeferLoading?: boolean }} cfg
 * @returns {{ inject: boolean, reason: string }}
 */
export function safetyDecision(request, cfg) {
  // 计数顺带返回给调用方做观测，这样 lib/index.js 不必新增 import（改 import 必须重启）。
  return { ...decide(request, cfg), nonTextResults: nonTextToolResults(request) }
}

function decide(request, cfg) {
  const mode = cfg.safetyMode ?? (cfg.safetyEnabled ? 'enforce' : 'off')
  if (mode === 'off') return { inject: false, reason: 'mode-off' }
  if ((cfg.safetySkipPurposes ?? []).includes(request.purpose)) return { inject: false, reason: 'purpose-skip' }
  // 非思考模式：client tools 与 safety_check 互斥（实测 400），必须跳过。
  if (!thinkingEnabled(request.body)) return { inject: false, reason: 'thinking-off' }
  // tool_result 里有图片/文档：safety_check 在场就会被服务端拒（实测 400），必须跳过。
  if (nonTextToolResults(request) > 0) return { inject: false, reason: 'non-text-tool-result' }
  if (cfg.safetyGuardDeferLoading !== false) {
    const tools = Array.isArray(request.body?.tools) ? request.body.tools : []
    if (tools.some(tool => tool && tool.defer_loading === true)) {
      return { inject: false, reason: 'defer-loading-guard' }
    }
  }
  if (mode === 'observe') return { inject: false, reason: 'observe' }
  return { inject: true, reason: 'enforce' }
}

/** 一次请求里带延迟声明的工具名，用于观测日志（不记录消息内容）。 */
export function deferredToolNames(request, limit = 10) {
  const tools = Array.isArray(request.body?.tools) ? request.body.tools : []
  return tools
    .filter(tool => tool && tool.defer_loading === true)
    .map(tool => tool.name ?? '(anonymous)')
    .slice(0, limit)
}

/**
 * 判断一个错误是否来自服务端拒答。
 *
 * dsh-llm-deepseek 的 translate.stopReason 不认识 `refusal`，会抛
 * `DeepSeek Messages stream: unsupported stop reason refusal`（LlmError/MALFORMED_RESPONSE）。
 * 真实拒答形态未主动构造，这里按适配器源码的措辞匹配。
 *
 * @param {unknown} error 抛出的错误或错误信息
 * @returns {boolean}
 */
export function isRefusalError(error) {
  const message = String(error && error.message ? error.message : error ?? '')
  return /unsupported stop reason refusal|stop_reason[^a-z]*refusal/i.test(message)
}
