import assert from 'node:assert/strict'
import { extensionOf, isPlainTextFile, purposeFormatError, PLAIN_TEXT_EXTENSIONS } from '../lib/files.js'

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
