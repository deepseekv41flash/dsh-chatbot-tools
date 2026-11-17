/**
 * 把 Markdown 正文转成「适合朗读的纯文本」。
 *
 * 实测（2026-11-17）：服务端 `filter_markdown: true` 会连**行内代码**一起剥掉，
 * 例如 "`ttsFilterMarkdown`（默认 `true`）" 被读成 "（默认）"，重要信息直接丢失。
 * 所以改为本地先转成纯文本，再让服务端不要再剥一遍。
 *
 * 规则：
 *   - 行内代码 `x` → x（必须保留，正是被服务端吃掉的那部分）
 *   - 围栏代码块：codeMode = skip 删除 / placeholder 念占位 / read 保留内容
 *   - 图片 ![alt](url) → alt；链接 [text](url) → text
 *   - 标题、强调、引用、列表符号、分割线、表格分隔行 → 去标记留文字
 */

const FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm
const FENCE_MARK = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/gm

/**
 * @param {string} markdown 原始 Markdown 文本
 * @param {{ codeMode?: 'skip' | 'placeholder' | 'read' }} [options]
 * @returns {string} 可直接送 TTS 的纯文本
 */
export function toSpeakable(markdown, options = {}) {
  const codeMode = options.codeMode ?? 'skip'
  let text = String(markdown ?? '')

  // 1) 围栏代码块
  if (codeMode === 'read') {
    // 只去掉围栏行，保留代码内容
    text = text.replace(FENCE_MARK, '')
  } else {
    text = text.replace(FENCE, () => (codeMode === 'placeholder' ? '\n（这里有一段代码）\n' : '\n'))
    // 无闭合围栏的残缺代码块：去掉开围栏行，避免把 ``` 念出来
    text = text.replace(FENCE_OPEN, '')
  }

  // 2) 行内代码：去掉反引号，保留内容
  text = text.replace(/(`+)([^`\n]+?)\1/g, '$2')

  // 3) 图片与链接
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // 4) 标题 / 引用 / 分割线
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  text = text.replace(/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[ \t]*$/gm, '')

  // 5) 表格：去掉分隔行与竖线
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
  text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_match, row) => row
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0)
    .join('，'))

  // 6) 强调与删除线
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')

  // 7) 列表符号、HTML 标签
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  text = text.replace(/<[^>]+>/g, ' ')

  // 8) 逐行去空白、丢空行，输出确定性文本
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
}

/**
 * 解析术语替换表。支持两种写法：
 *   JSON：'{"Markdown":"马克当","API":"接口"}'
 *   键值对：'Markdown=马克当, API=接口'（也支持中文逗号与换行分隔）
 *
 * 用途：官方 TTS 没有 prompt / 语种参数（只有 text、voice_id、format、filter_markdown），
 * 英文词在中文语境里可能被误判语种或同化（Markdown → Mardeano / 韩文），
 * 只能在朗读前把易错词换成读音稳定的说法。
 *
 * @param {unknown} raw 配置里的原始字符串
 * @returns {Array<[string, string]>} 按替换顺序排列的 [原文, 读法]
 */
export function parseTermMap(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return []
  const pairs = []
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof key === 'string' && key.length > 0 && typeof value === 'string') pairs.push([key, value])
      }
      return pairs
    } catch {
      return []
    }
  }
  for (const chunk of text.split(/[,，\n]/)) {
    const entry = chunk.trim()
    if (entry.length === 0) continue
    const index = entry.indexOf('=')
    if (index <= 0) continue
    const key = entry.slice(0, index).trim()
    const value = entry.slice(index + 1).trim()
    if (key.length > 0 && value.length > 0) pairs.push([key, value])
  }
  return pairs
}

const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]+$/

/**
 * 短键（≤2 个 ASCII 字符，如 AI / ML / Go）要按「整词」替换。
 *
 * 实测（2026-11-17）：纯子串替换下 `AI` 会命中 `OPENAI` → `OPEN【AI】`。
 * 短键几乎总是缩写，撞进更长的英文单词里基本都是误伤；而长键（`Markdown`）
 * 即使在标识符内部（`ttsFilterMarkdown`）替换也是想要的 —— 朗读文本没有语法，
 * 替换只为发音正确，所以长键继续用子串替换。
 */
function isShortAsciiKey(from) {
  return from.length <= 2 && PRINTABLE_ASCII_ONLY.test(from)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 按术语表替换（长词优先，避免「Markdown」被更短的词先吃掉）。
 *
 * 匹配语义：
 *   - 大小写敏感（`Markdown` 不命中 `markdown`）
 *   - 长词优先（`ttsFilterMarkdown` 先于 `Markdown` 命中）
 *   - ≤2 字符的 ASCII 短键按整词匹配（`AI` 不命中 `OPENAI`）
 *   - 其余键为纯子串替换（标识符内部也替换）
 *
 * @param {string} text 已转换的朗读文本
 * @param {Array<[string, string]>} pairs parseTermMap 的结果
 * @returns {string}
 */
export function applyTerms(text, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return text
  const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length)
  let out = text
  for (const [from, to] of ordered) {
    if (from.length === 0) continue
    if (isShortAsciiKey(from)) {
      // 用函数式替换，避免替换值里的 `$&`、`$1` 被当成捕获组引用
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(from)}(?![A-Za-z0-9_])`, 'g')
      out = out.replace(pattern, () => to)
    } else {
      out = out.split(from).join(to)
    }
  }
  return out
}
