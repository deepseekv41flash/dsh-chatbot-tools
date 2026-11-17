import assert from 'node:assert/strict'
import { extensionOf, isPlainTextFile, purposeFormatError, uploadFailureHint, PLAIN_TEXT_EXTENSIONS } from '../lib/files.js'

const cases = [
  // ── extensionOf ────────────────────────────────────────────────────────────
  ['Windows 路径取扩展名', () => assert.equal(extensionOf('C:\\a\\b\\note.TXT'), '.txt')],
  ['POSIX 路径取扩展名', () => assert.equal(extensionOf('/home/u/doc.Pdf'), '.pdf')],
  ['无扩展名返回空串', () => assert.equal(extensionOf('C:\\a\\b\\README'), '')],
  ['隐藏文件不算扩展名', () => assert.equal(extensionOf('/tmp/.env'), '')],
  ['目录名里的点不干扰', () => assert.equal(extensionOf('/a.b/c/d'), '')],
  ['多点取最后一段', () => assert.equal(extensionOf('/a/report.final.docx'), '.docx')],

  // ── isPlainTextFile ───────────────────────────────────────────────────────
  ['txt 是纯文本', () => assert.equal(isPlainTextFile('a.txt'), true)],
  ['md 是纯文本', () => assert.equal(isPlainTextFile('a.MD'), true)],
  ['csv 是纯文本', () => assert.equal(isPlainTextFile('a.csv'), true)],
  ['docx 不是纯文本', () => assert.equal(isPlainTextFile('a.docx'), false)],
  ['pdf 不是纯文本', () => assert.equal(isPlainTextFile('a.pdf'), false)],
  ['png 不是纯文本', () => assert.equal(isPlainTextFile('a.png'), false)],

  // ── purposeFormatError：只在「解析类 × 纯文本」时报错 ──────────────────────
  [
    'txt + text_recognition → 报错（实测会 400）',
    () => {
      const msg = purposeFormatError('note.txt', 'text_recognition')
      assert.ok(msg && msg.includes('user_data'), '应提示改用 user_data')
      assert.ok(msg.includes('.txt'), '应指出具体扩展名')
    },
  ],
  [
    'md + rich_layout_recognition → 报错',
    () => assert.ok(purposeFormatError('doc.md', 'rich_layout_recognition')),
  ],
  [
    'txt + user_data → 放行（实测 200）',
    () => assert.equal(purposeFormatError('note.txt', 'user_data'), null),
  ],
  [
    'docx + text_recognition → 放行（实测 200）',
    () => assert.equal(purposeFormatError('report.docx', 'text_recognition'), null),
  ],
  [
    'pdf + rich_layout_recognition → 放行',
    () => assert.equal(purposeFormatError('deck.pdf', 'rich_layout_recognition'), null),
  ],
  [
    'json + user_data → 放行（实测 200）',
    () => assert.equal(purposeFormatError('data.json', 'user_data'), null),
  ],
  [
    '未知扩展名不拦（交给服务端判断）',
    () => assert.equal(purposeFormatError('weird.xyz', 'text_recognition'), null),
  ],

  // ── 表本身的自洽性 ─────────────────────────────────────────────────────────
  ['扩展名表每项都以点开头且小写', () => {
    for (const ext of PLAIN_TEXT_EXTENSIONS) {
      assert.equal(ext, ext.toLowerCase())
      assert.ok(ext.startsWith('.'), `${ext} 应以点开头`)
    }
  }],

  // ── uploadFailureHint：文案细分规则对齐官方 chat-demo 的 errors.ts ──────────
  [
    '400 文件数量上限',
    () => {
      const hint = uploadFailureHint(400, 'User file count limit exceeded, limit 100')
      assert.ok(hint.includes('100'), '应带出上限数值')
      assert.ok(hint.includes('数量'))
    },
  ],
  [
    '400 存储配额上限',
    () => {
      const hint = uploadFailureHint(400, 'User storage quota exceeded, limit 10.5 GB')
      assert.ok(hint.includes('10.5 GB'))
      assert.ok(hint.includes('配额'))
    },
  ],
  [
    '400 不受支持/损坏',
    () => assert.ok(uploadFailureHint(400, 'You have uploaded an invalid image').includes('不受支持')),
  ],
  [
    '400 图片过大',
    () => assert.ok(uploadFailureHint(400, 'The image is too large to process').includes('过大')),
  ],
  [
    '400 有密码保护',
    () => assert.ok(uploadFailureHint(400, 'the file is password-protected').includes('密码')),
  ],
  [
    '400 无法解析（指向 user_data）',
    () => {
      const hint = uploadFailureHint(400, 'Failed to recognize the file: the file format is not supported')
      assert.ok(hint.includes('user_data'), '纯文本场景应提示改用 user_data')
    },
  ],
  [
    '400 未知文案给兜底建议',
    () => {
      const hint = uploadFailureHint(400, 'totally unknown failure')
      assert.ok(hint.includes('purpose'), '兜底应提示检查 purpose')
    },
  ],
  ['429 命中并发上限', () => assert.ok(uploadFailureHint(429, '').includes('15'))],
  ['503 提示稍后重试', () => assert.ok(uploadFailureHint(503, '').includes('稍后'))],
  ['非失败状态没有提示', () => assert.equal(uploadFailureHint(200, ''), '')],
  ['未收录的状态码不瞎猜', () => assert.equal(uploadFailureHint(418, 'teapot'), '')],
]

let passed = 0
for (const [label, fn] of cases) {
  try {
    fn()
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
