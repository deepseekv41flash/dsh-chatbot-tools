import assert from 'node:assert/strict'
import { applyTerms, parseTermMap, toSpeakable } from '../lib/speakable.js'

const cases = [
  [
    '行内代码保留（服务端会吃掉的那部分）',
    '`ttsFilterMarkdown`（默认 `true`，设置页可改）',
    'ttsFilterMarkdown（默认 true，设置页可改）',
  ],
  ['围栏代码块默认删掉', '前一段。\n```js\nconst a = 1\n```\n后一段。', '前一段。\n后一段。'],
  [
    '代码块替换为占位',
    '前一段。\n```js\nconst a = 1\n```\n后一段。',
    '前一段。\n（这里有一段代码）\n后一段。',
    { codeMode: 'placeholder' },
  ],
  [
    '代码块保留（read 模式只去围栏）',
    '前一段。\n```js\nconst a = 1\n```\n后一段。',
    '前一段。\nconst a = 1\n后一段。',
    { codeMode: 'read' },
  ],
  ['链接保留文字', '见 [文档](https://example.com/a?b=1)。', '见 文档。'],
  ['图片保留 alt', '![架构图](https://x/y.png) 说明', '架构图 说明'],
  ['标题与强调去标记', '## 小标题\n**加粗** 与 *斜体*', '小标题\n加粗 与 斜体'],
  ['列表与引用去符号', '- 第一项\n- 第二项\n> 引用', '第一项\n第二项\n引用'],
  ['表格去分隔行与竖线', '| a | b |\n|---|---|\n| 1 | 2 |', 'a，b\n1，2'],
]

// 术语表：解析 + 匹配语义（2026-11-17 实测后固化）
const termCases = [
  [
    '长键在标识符内部也替换（TTS 要的发音）',
    '{"Markdown":"马克当文档"}',
    '跑一下 ttsFilterMarkdown 这个词',
    '跑一下 ttsFilter马克当文档 这个词',
  ],
  ['短键不撞进更长的英文单词', '{"AI":"人工智能"}', 'OPENAI 与 AI 都出现', 'OPENAI 与 人工智能 都出现'],
  ['短键在中文边界正常命中', '{"AI":"人工智能"}', '这个 AI 很强', '这个 人工智能 很强'],
  ['短键在标点边界正常命中', '{"Go":"狗语言"}', '用 Go，可以', '用 狗语言，可以'],
  ['大小写敏感', '{"Markdown":"马克当文档"}', 'markdown 小写不动', 'markdown 小写不动'],
  [
    '长词优先',
    'Markdown=马克当文档, ttsFilterMarkdown=过滤器',
    'ttsFilterMarkdown 与 Markdown',
    '过滤器 与 马克当文档',
  ],
  ['键值对写法（中文逗号）', 'API=接口，SDK=工具包', 'API 与 SDK', '接口 与 工具包'],
  ['替换值里的 $ 不被当成捕获组', '{"价格":"$& 元"}', '价格 是多少', '$& 元 是多少'],
  ['非法 JSON 退回空表', '{"Markdown":', 'Markdown 原文', 'Markdown 原文'],
]

let failed = 0
for (const [label, input, expected, options] of cases) {
  const got = toSpeakable(input, options)
  try {
    assert.equal(got, expected)
    console.log(`PASS  ${label}`)
  } catch {
    failed++
    console.error(`FAIL  ${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(got)}`)
  }
}

for (const [label, rawMap, input, expected] of termCases) {
  const got = applyTerms(input, parseTermMap(rawMap))
  try {
    assert.equal(got, expected)
    console.log(`PASS  ${label}`)
  } catch {
    failed++
    console.error(`FAIL  ${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(got)}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`)
  process.exit(1)
}
console.log('\n全部用例通过')
