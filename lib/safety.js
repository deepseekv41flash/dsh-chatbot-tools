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
  // 总开关优先，且**默认关闭**。理由：safety_check 会限制 DSH 本身的能力
  // （内容审核会拒掉网安红队/渗透测试这类正常需求），插件不应替用户做这个决定。
  // 只有显式把 safetyEnabled 设为 true 才会进入下面的判定。
  if (cfg.safetyEnabled !== true) return { inject: false, reason: 'mode-off' }
  const mode = cfg.safetyMode ?? 'enforce'
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
/**
 * 判断一个错误是不是「内容安全拦截」，而不是普通网络/服务故障。
 *
 * 官方文档 <https://api-docs.deepseek.com/zh-cn/guides/safety> 写明开启 safety_check 后
 * 有两种被拦形态，**都必须识别**，否则会被当成普通错误丢给用户：
 *
 *   1. 输出侧拒答 —— 响应以 `stop_reason: "refusal"`（附 `stop_details.type: "refusal"`）结束。
 *      DSH 适配器遇到不认识的 stop reason 会抛错，措辞形如 `unsupported stop reason: refusal`，
 *      所以匹配 "unsupported stop reason refusal" / "stop_reason ... refusal"。
 *   2. 输入侧未过审 —— **请求直接返回 `400 Content Exists Risk`**（图片被拦时还会附
 *      `The following images were blocked by content moderation: messages.1.content.0`）。
 *      这一条不会走到 stop_reason，是一条纯 HTTP 400，早期版本漏识别，表现成普通报错。
 *
 * 另外：`max_tokens` 截断、网络错误都不是拒答，不能被误判成「被内容安全拦截」，
 * 否则用户会收到错误的提示。
 */
export function isRefusalError(error) {
  const message = String(error && error.message ? error.message : error ?? '')
  return /unsupported stop reason[^a-z]*refusal|stop_reason[^a-z]*refusal|content exists risk|blocked by content moderation/i
    .test(message)
}


// ── 拒答兜底：做成可测的纯异步生成器 ─────────────────────────────────────────
//
// 为什么抽出来：真实拒答极难触发（见 docs/verification-2026-11-17.md §22），
// 如果判定逻辑留在 `apply()` 里的中间件中，这条分支就永远只有「看代码推断」。
// 抽成接收 `next()` 的生成器后，可以用「抛一个带真实文案的错误」确定性地驱动它，
// 从而真正验证**它 yield 了什么**，而不只是验证匹配器返回了 true。

/** 两种被拦形态各自给用户的提示。输入未过审时模型根本没作答，措辞必须不同。 */
export const REFUSAL_NOTICE = {
  /** 输出侧拒答：回答被撤回。 */
  output:
    '⚠️ 该回答已被 DeepSeek 内容安全策略拦截（refusal）。'
    + '可在 设置 → 插件 → dsh-chatbot-tools 里调整内容安全开关后重试。',
  /** 输入侧未过审：HTTP 400，模型没有回答。 */
  input:
    '⚠️ 这条输入未通过 DeepSeek 内容安全审核（HTTP 400 Content Exists Risk），模型没有作答。'
    + '可在 设置 → 插件 → dsh-chatbot-tools 里关闭内容安全后重试。',
}

/**
 * 判断这次被拦是「输入未过审」还是「输出侧拒答」。
 * @param {unknown} error
 * @returns {'input' | 'output'}
 */
export function refusalKind(error) {
  const detail = String(error && error.message ? error.message : error ?? '')
  return /content exists risk|blocked by content moderation/i.test(detail) ? 'input' : 'output'
}

/**
 * `llm/stream` 的拒答兜底包装。
 *
 * - `enabled` 为假时**原样透传**，连异常都不碰（等价于本插件不存在）；
 * - 开启时只接管 `isRefusalError()` 认得的错误，其余错误照常抛出，
 *   免得把限流、网络故障这类问题伪装成「被内容安全拦截」；
 * - 命中后按 DSH 的流式协议发一段完整文本块并正常收尾。
 *
 * @param {() => Promise<AsyncIterable<object>> | AsyncIterable<object>} next 下游流
 * @param {boolean} enabled 是否接管
 * @returns {AsyncGenerator<object>}
 */
export async function* refusalGuardStream(source, enabled) {
  // `source` 必须由调用方**同步**取得（见 lib/index.js）：cordis 的 waterfall 要求
  // handler 执行期间就调用 `next()`。
  //
  // 2026-11-18 端到端实测（mock Messages 服务 + 独立 profile）纠正了两个错误假设：
  //   1. 适配器**不抛异常**。它吐一个 `finish` chunk：
  //        { type:'finish', reason:{ kind:'error', failure:{ code:'MALFORMED_RESPONSE',
  //          message:'DeepSeek Messages stream: unsupported stop reason refusal' } } }
  //      所以只 catch 异常的写法在真实环境**从未生效过**。
  //   2. 拒答流里那个「空 text 块」会先以 block-start/block-end 到达，之后才是 finish 失败。
  // 因此：既要处理 finish 失败 chunk，也保留 catch 兜住真的抛异常的适配器。
  let lastIndex = -1
  const emit = (text) => {
    const index = lastIndex + 1
    return [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
  try {
    for await (const chunk of source) {
      if (chunk && typeof chunk.index === 'number' && chunk.index > lastIndex) lastIndex = chunk.index
      if (enabled && isRefusalFailureChunk(chunk)) {
        yield* emit(REFUSAL_NOTICE[refusalKind(chunk.reason.failure)])
        return
      }
      yield chunk
    }
  } catch (error) {
    if (!enabled || !isRefusalError(error)) throw error
    yield* emit(REFUSAL_NOTICE[refusalKind(error)])
  }
}

/**
 * 这个 chunk 是不是「适配器以 finish 失败交付的拒答」。
 * DSH 的 FinishReasonMap 里没有 `refusal` 这一种，适配器把它降级成
 * `{ kind:'error', failure:{ code:'MALFORMED_RESPONSE', message:'…refusal' } }`。
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
export function isRefusalFailureChunk(chunk) {
  if (!chunk || chunk.type !== 'finish') return false
  const reason = chunk.reason
  if (!reason || reason.kind !== 'error') return false
  return isRefusalError(reason.failure)
}
