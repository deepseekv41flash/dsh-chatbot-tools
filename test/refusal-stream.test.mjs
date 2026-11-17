// refusalGuardStream 的确定性分支测试。
//
// 背景：真实拒答极难触发（docs/verification-2026-11-17.md §22 实测 5 类均未命中），
// 所以「拦截分支」以前只能靠看代码推断。抽出成纯生成器后，可以用「抛一个带真实文案的
// 错误」确定性地驱动它，验证它**到底 yield 了什么**。
import assert from 'node:assert/strict'
import { refusalGuardStream, refusalKind, isRefusalError, REFUSAL_NOTICE } from '../lib/safety.js'

/** 下游流：先吐两个 chunk 再抛错。 */
const throwing = (error) => async function* () {
  yield { type: 'text-delta', index: 0, text: '前半段' }
  throw error
}

/** 下游流：正常吐两个 chunk 后结束。 */
const normal = async function* () {
  yield { type: 'text-delta', index: 0, text: '正常' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const collect = async (iterable) => {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const ADAPTER_REFUSAL = new Error('DeepSeek Messages stream: unsupported stop reason refusal')
const INPUT_BLOCKED = new Error('DeepSeek Messages API error 400: {"error":{"message":"Content Exists Risk"}}')
const IMAGE_BLOCKED = new Error('The following images were blocked by content moderation: messages.1.content.0')
const RATE_LIMIT = new Error('429 rate_limit_exceeded')

const cases = [
  // ── 关闭：必须原样透传，连异常都不能碰 ────────────────────────────────────
  ['关闭时正常流原样透传', async () => {
    const chunks = await collect(refusalGuardStream(normal, false))
    assert.deepEqual(chunks, [
      { type: 'text-delta', index: 0, text: '正常' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }],
  ['关闭时拒答异常照常抛出（不吞）', async () => {
    await assert.rejects(() => collect(refusalGuardStream(throwing(ADAPTER_REFUSAL), false)), /unsupported stop reason refusal/)
  }],

  // ── 开启 + 正常：一个 chunk 都不能变 ──────────────────────────────────────
  ['开启时正常流原样透传', async () => {
    const chunks = await collect(refusalGuardStream(normal, true))
    assert.deepEqual(chunks, [
      { type: 'text-delta', index: 0, text: '正常' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }],

  // ── 开启 + 输出侧拒答：已下发的 chunk 保留，再补一段提示并收尾 ────────────
  ['输出侧拒答：保留已下发内容并追加提示', async () => {
    const chunks = await collect(refusalGuardStream(throwing(ADAPTER_REFUSAL), true))
    assert.equal(chunks.length, 5, '一个已下发 chunk + 4 个兜底 chunk')
    assert.deepEqual(chunks[0], { type: 'text-delta', index: 0, text: '前半段' })
    assert.deepEqual(chunks[1], { type: 'block-start', index: 0, blockType: 'text' })
    assert.equal(chunks[2].type, 'text-delta')
    assert.equal(chunks[2].text, REFUSAL_NOTICE.output)
    assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: REFUSAL_NOTICE.output } })
    assert.deepEqual(chunks[4], { type: 'finish', reason: { kind: 'stop' } })
  }],

  // ── 开启 + 输入未过审：文案必须与输出侧不同（模型根本没作答） ─────────────
  ['输入未过审：用「输入」文案', async () => {
    const chunks = await collect(refusalGuardStream(throwing(INPUT_BLOCKED), true))
    assert.equal(chunks[2].text, REFUSAL_NOTICE.input)
    assert.notEqual(REFUSAL_NOTICE.input, REFUSAL_NOTICE.output, '两种形态的文案必须可区分')
    assert.ok(chunks[2].text.includes('400'), '输入侧提示应点明是 400')
  }],
  ['图片被拦：同样按「输入」处理', async () => {
    const chunks = await collect(refusalGuardStream(throwing(IMAGE_BLOCKED), true))
    assert.equal(chunks[2].text, REFUSAL_NOTICE.input)
  }],

  // ── 开启 + 非拒答错误：必须原样抛出，不能被伪装成「被拦截」 ───────────────
  ['开启时限流错误照常抛出', async () => {
    await assert.rejects(() => collect(refusalGuardStream(throwing(RATE_LIMIT), true)), /rate_limit_exceeded/)
  }],
  ['开启时网络错误照常抛出', async () => {
    await assert.rejects(() => collect(refusalGuardStream(throwing(new Error('fetch failed')), true)), /fetch failed/)
  }],

  // ── 兜底 chunk 必须构成一段合法文本块（start→delta→end→finish） ───────────
  ['兜底 chunk 结构完整可渲染', async () => {
    const chunks = await collect(refusalGuardStream(throwing(ADAPTER_REFUSAL), true))
    const tail = chunks.slice(-4)
    assert.equal(tail[0].type, 'block-start')
    assert.equal(tail[0].blockType, 'text')
    assert.equal(tail[1].type, 'text-delta')
    assert.equal(tail[2].type, 'block-end')
    assert.equal(tail[2].block.text, tail[1].text, 'block-end 必须带上完整正文')
    assert.equal(tail[3].type, 'finish')
    assert.equal(tail[3].reason.kind, 'stop')
  }],

  // ── refusalKind 与 isRefusalError 的一致性 ────────────────────────────────
  ['refusalKind 只对认得的情况给 input', () => {
    assert.equal(refusalKind(INPUT_BLOCKED), 'input')
    assert.equal(refusalKind(IMAGE_BLOCKED), 'input')
    assert.equal(refusalKind(ADAPTER_REFUSAL), 'output')
  }],
  ['isRefusalError 与分支判断口径一致', () => {
    for (const error of [ADAPTER_REFUSAL, INPUT_BLOCKED, IMAGE_BLOCKED]) {
      assert.equal(isRefusalError(error), true, `应判为拒答：${error.message.slice(0, 40)}`)
    }
    for (const error of [RATE_LIMIT, new Error('fetch failed')]) {
      assert.equal(isRefusalError(error), false, `不应判为拒答：${error.message}`)
    }
  }],
]

let passed = 0
for (const [label, fn] of cases) {
  try {
    await fn()
    console.log('PASS  ' + label)
    passed++
  } catch (error) {
    console.log('FAIL  ' + label)
    console.error(error)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${cases.length} 通过`)
if (passed === cases.length) console.log('\n全部用例通过')
