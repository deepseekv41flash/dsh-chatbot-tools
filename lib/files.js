/**
 * Files API 的「用途 × 文件格式」兼容性判定（无外部依赖，便于离线测试）。
 *
 * 实测（2026-11-18，`POST https://api.deepseek.com/files`）：
 *   - `txt` + `user_data`            → 200
 *   - `txt` + `text_recognition`     → 400 `Failed to recognize the file: the file format is not supported`
 *   - `md`  + `user_data`            → 200
 *   - `json` + `user_data`           → 200
 *
 * 也就是：**解析类用途只接受文档格式**，纯文本类格式只能用 `user_data`。
 * 服务端的报错完全没提「格式与用途不匹配」，只丢一句 format is not supported，
 * 很容易被误判成「文件损坏」或「格式不支持」，所以这里做前置拦截并给出可执行的建议。
 */

/** 服务端只按 user_data 接受的纯文本类扩展名。 */
export const PLAIN_TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.ini', '.conf', '.rst',
]

/** 会解析并按页计费的用途。 */
export const PARSING_PURPOSES = ['text_recognition', 'rich_layout_recognition']

/**
 * 取小写扩展名（含点）。没有扩展名返回空串。
 * @param {string} filePath
 * @returns {string}
 */
export function extensionOf(filePath) {
  const name = String(filePath ?? '')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * 文件是否属于「只能配 user_data」的纯文本类格式。
 * @param {string} filePath
 * @returns {boolean}
 */
export function isPlainTextFile(filePath) {
  return PLAIN_TEXT_EXTENSIONS.includes(extensionOf(filePath))
}

/**
 * 把 Files API 的上传失败翻译成一句可执行的中文建议。
 *
 * 400 的文案细分规则直接取自官方演示客户端
 * `deepseek-ai/chat-demo` 的 `src/services/api/errors.ts`（`getUploadErrorInfo`），
 * 那边同样认为「400 只带 message 文本，只能按文案区分」：
 *   - `User file count limit exceeded … limit (\d+)`   → 文件数量上限
 *   - `User storage quota exceeded … limit ([\d.]+) GB` → 存储配额上限
 *   - `You have uploaded an (unsupported|invalid) (file|image)`
 *   - `The image is too large to process`
 *   - `password-protected`
 *   - `Failed to recognize the file`
 *
 * @param {number} status HTTP 状态码
 * @param {string} [detail] 服务端返回的错误文本
 * @returns {string} 括号形式的后缀，无匹配时返回空串
 */
export function uploadFailureHint(status, detail) {
  const text = String(detail ?? '')
  if (status === 400) {
    const count = /User file count limit exceeded.*?limit (\d+)/i.exec(text)
    if (count) return `（文件数量已达上限 ${count[1]} 个，先清理不再需要的旧文件）`
    const storage = /User storage quota exceeded.*?limit ([\d.]+) GB/i.exec(text)
    if (storage) return `（存储配额已满，上限 ${storage[1]} GB，先清理旧文件）`
    if (/You have uploaded an (unsupported|invalid) (file|image)/i.test(text)) {
      return '（服务端判定该文件不受支持或已损坏，换一份文件试试）'
    }
    if (/The image is too large to process/i.test(text)) {
      return '（图片尺寸过大，服务端无法处理，先缩小再上传）'
    }
    if (/password-protected/i.test(text)) {
      return '（文件有密码保护，服务端无法解析，先去掉密码）'
    }
    if (/Failed to recognize the file/i.test(text)) {
      return '（服务端无法解析该文件：格式不受支持、已加密或已损坏；纯文本类文件请改用 purpose="user_data"）'
    }
    return '（400：常见原因是格式与 purpose 不匹配，或 purpose 字段被排在 file 之后）'
  }
  const hints = {
    408: '（上传太慢，需在 120 秒内传完）',
    413: '（文件超过 100 MiB）',
    429: '（账号并发上传过多，上限 15，等一会儿再试）',
    500: '（解析结果不完整）',
    503: '（服务繁忙，稍后重试）',
    504: '（解析超过 120 秒）',
  }
  return hints[status] ?? ''
}

/**
 * 用途与格式冲突时返回给模型看的错误文本；不冲突返回 null。
 *
 * @param {string} filePath 本地路径
 * @param {string} purpose  text_recognition / rich_layout_recognition / user_data
 * @returns {string | null}
 */
export function purposeFormatError(filePath, purpose) {
  const ext = extensionOf(filePath)
  if (!PARSING_PURPOSES.includes(purpose)) return null
  if (!isPlainTextFile(filePath)) return null
  return [
    `用途与格式不匹配：${ext || '(无扩展名)'} 属于纯文本格式，服务端只接受 purpose="user_data"（不解析、不计费）。`,
    '解析类用途（text_recognition / rich_layout_recognition）需要文档格式，例如 pdf / docx / pptx / xlsx。',
    '两种改法：① 改用 purpose="user_data"；② 先把文件转成 PDF/DOCX 再上传。',
    '（服务端对此的原话是 "Failed to recognize the file: the file format is not supported"，不会说明是用途不匹配。）',
  ].join('\n')
}
