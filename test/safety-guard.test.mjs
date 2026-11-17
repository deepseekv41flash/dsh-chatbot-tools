import assert from 'node:assert/strict'
import { deferredToolNames, isRefusalError, safetyDecision } from '../lib/safety.js'

const base = { safetyLevel: 'high', safetySkipPurposes: ['title'], safetyGuardDeferLoading: true }
const plain = [{ name: 'shell', input_schema: { type: 'object' } }]
const deferred = [
  { name: 'shell', input_schema: { type: 'object' } },
  { name: 'chatbot_search', input_schema: { type: 'object' }, defer_loading: true },
]
// read_image 这类工具会把图片块塞进 tool_result；此时 safety_check 在场会被服务端拒。
const imageToolResult = {
  tools: plain,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '看一下这张图' }] },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    },
  ],
}
const textToolResult = {
  tools: plain,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: '内容' }] }],
    },
  ],
}
// tool_result 的 content 也可以是纯字符串（等价于单个 text 块），不算非文本。
const stringToolResult = {
  tools: plain,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_3', content: '纯文本结果' }] }],
}

const cases = [
  ['off 不注入', { purpose: 'chat' }, { ...base, safetyMode: 'off' }, false, 'mode-off'],
  ['observe 只记录', { purpose: 'chat', body: { tools: plain } }, { ...base, safetyMode: 'observe' }, false, 'observe'],
  ['enforce 正常注入', { purpose: 'chat', body: { tools: plain } }, { ...base, safetyMode: 'enforce' }, true, 'enforce'],
  [
    'enforce + defer_loading 必须跳过（事故守卫）',
    { purpose: 'chat', body: { tools: deferred } },
    { ...base, safetyMode: 'enforce' },
    false,
    'defer-loading-guard',
  ],
  ['title 请求跳过', { purpose: 'title', body: { tools: plain } }, { ...base, safetyMode: 'enforce' }, false, 'purpose-skip'],
  [
    '守卫可关闭（仅用于复现事故）',
    { purpose: 'chat', body: { tools: deferred } },
    { ...base, safetyMode: 'enforce', safetyGuardDeferLoading: false },
    true,
    'enforce',
  ],
  ['无 tools 字段时按正常注入', { purpose: 'chat', body: {} }, { ...base, safetyMode: 'enforce' }, true, 'enforce'],
  [
    '非思考模式必须跳过（client tools 与 safety_check 互斥）',
    { purpose: 'chat', body: { tools: plain, thinking: { type: 'disabled' } } },
    { ...base, safetyMode: 'enforce' },
    false,
    'thinking-off',
  ],
  [
    '思考模式显式 enabled 时注入',
    { purpose: 'chat', body: { tools: plain, thinking: { type: 'enabled' } } },
    { ...base, safetyMode: 'enforce' },
    true,
    'enforce',
  ],
  [
    '旧布尔开关向后兼容',
    { purpose: 'chat', body: { tools: plain } },
    { ...base, safetyEnabled: true },
    true,
    'enforce',
  ],
  [
    'tool_result 带图片必须跳过（2026-11-17 第二起事故）',
    { purpose: 'chat', body: imageToolResult },
    { ...base, safetyMode: 'enforce' },
    false,
    'non-text-tool-result',
  ],
  [
    'tool_result 纯文本不影响注入',
    { purpose: 'chat', body: textToolResult },
    { ...base, safetyMode: 'enforce' },
    true,
    'enforce',
  ],
  [
    'tool_result 为字符串时不影响注入',
    { purpose: 'chat', body: stringToolResult },
    { ...base, safetyMode: 'enforce' },
    true,
    'enforce',
  ],
  [
    '图片 tool_result 与 defer_loading 同时出现时，先命中的是图片守卫',
    { purpose: 'chat', body: { ...imageToolResult, tools: deferred } },
    { ...base, safetyMode: 'enforce' },
    false,
    'non-text-tool-result',
  ],
]

let failed = 0
for (const [label, request, cfg, inject, reason] of cases) {
  const got = safetyDecision(request, cfg)
  try {
    assert.equal(got.inject, inject)
    assert.equal(got.reason, reason)
    console.log(`PASS  ${label} → ${got.reason}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${label} → ${JSON.stringify(got)}，期望 ${reason}/${inject}`)
  }
}

const names = deferredToolNames({ body: { tools: deferred } })
assert.deepEqual(names, ['chatbot_search'])
console.log('PASS  deferredToolNames 只列出带延迟声明的工具')

// ── 拒答匹配（M4 兜底）──────────────────────────────────────────────────────
const refusalCases = [
  ['适配器真实措辞', new Error('DeepSeek Messages stream: unsupported stop reason refusal'), true],
  ['带 response 前缀', 'MALFORMED_RESPONSE: unsupported stop reason refusal', true],
  ['stop_reason 形态', 'stop_reason="refusal"', true],
  ['max_tokens 不是拒答', new Error('DeepSeek Messages stream: unsupported stop reason max_tokens'), false],
  ['网络错误不是拒答', new Error('fetch failed'), false],
  ['空值安全', undefined, false],
]
for (const [label, error, expected] of refusalCases) {
  const got = isRefusalError(error)
  try {
    assert.equal(got, expected)
    console.log(`PASS  拒答匹配：${label} → ${got}`)
  } catch {
    failed++
    console.error(`FAIL  拒答匹配：${label} → ${got}，期望 ${expected}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`)
  process.exit(1)
}
console.log('\n全部用例通过')
