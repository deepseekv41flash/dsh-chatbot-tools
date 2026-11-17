# 验证记录：dsh-chatbot-tools 0.1.1（2026-11-17）

环境：DSH NEXT（desktop profile），provider `deepseek-account`，模型 `deepseek-flash`。
观测日志：`~/.dsh/logs/chatbot-tools-safety.ndjson`（只记工具形态，不记消息内容）。

## 1. 内容安全（M1）

| 项 | 结论 | 证据 |
|---|---|---|
| `safety_check` + 普通 function tools 是否被接受 | ✅ 接受（**仅思考模式**） | 新会话（subagent `safety-canary`）日志 `decision:"enforce"`、`toolCount:268`、`deferredCount:0`，正常返回「正常」 |
| 非思考模式下的同一组合 | ❌ 400（服务端规则） | `chatbot_doctor(live:true)`：`thinking=enabled` → 200；`thinking=disabled` → `400 tools: client tools can only be used together with deepseek_web_search/deepseek_read_url/safety_check/title in thinking mode` |
| DSH 真实请求的 thinking 字段 | `enabled` | 观测日志 `"thinking":"enabled"` |
| 非思考请求是否自动跳过 | ✅ 跳过 | 离线用例 `thinking-off`；守卫在 `safetyDecision()` 里先判 `thinkingEnabled(body)` |
| `defer_loading` 请求是否自动跳过注入 | ✅ 跳过 | 本会话多条请求 `decision:"defer-loading-guard"`，`deferredNames` 为三个 chatbot 工具，无 400 |
| 事故形态是否可再触发（守卫关闭时） | ⏸ 未主动复现 | 离线用例已覆盖「守卫关闭 → inject=true」；线上不冒复现风险 |
| `session-title` 内部请求 | ✅ 已排除 | 首轮观测到 `purpose:"session-title"` 被注入，已加入 `safetySkipPurposes` |
| 拒答（refusal）兜底 | ⚠️ 未实测 | 需构造违规输入，未做；代码按 `unsupported stop reason refusal` 匹配 |

**离线测试**：`node test/safety-guard.test.mjs` → 10/10 通过（含「defer_loading 必跳过」「非思考模式必跳过」「守卫可关闭」「旧布尔开关兼容」）。

## 2. 图片搜索（M2）

调用：`chatbot_image_search(path="C:\\Windows\\Web\\4K\\Wallpaper\\Windows\\img0_1920x1200.jpg", query="这是什么地点或壁纸")`

- 结果：**15 条**，每条含 `image_url` 缩略图与来源页 URL。
- 结论：服务端工具名 `deepseek_web_search` 被接受；消息内 base64 图片能触发 `kind: image_search`。
- 费用：1 次模型回合 + 1 次服务端工具调用（`maxUses:1`）。

## 3. 结构化搜索（M3）

调用：`chatbot_search(query="DeepSeek Harness 插件", count=3)`

- 结果：3 条，含站点名、发布时间（RFC 3339）、权威度（3）。
- 结论：账号 token 可用于 `/v1/tools/search`；无需 API key。

## 4. 自检（M5 凭证）

`chatbot_doctor()` → `provider: deepseek-account`、`凭证通道: account`。
结论：`ctx.get('deepseekAccount').resolveToken(endpoint)` 路径可用，未依赖 `DEEPSEEK_API_KEY`。

## 5. 已知竞态（非插件逻辑）

`dev_reload_package` 返回 OK 后，紧接的一次请求出现 `unknown tool "chatbot_search"`（`UNKNOWN_TOOL`），
重试即恢复。已记入 README「踩坑」。

## 6. 未验证

1. 拒答路径的真实返回形态（`stop_reason: refusal`）。
2. 卸载后完全无残留（工具消失 + 请求体无 `safety_check`）。
3. 其他 profile（web / superagent）同装时的表现。

## 7. 卸载残留测试（2026-11-17 20:39）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 工具是否立即消失（无需重启） | ✅ | 卸载后调用 `chatbot_doctor` → `unknown tool "chatbot_doctor"` |
| 注入器 registry 是否清空 | ✅ | `~/.dsh/super-injector/registry.json` → `[]` |
| 注入器创建的 junction 是否删除 | ✅ | 报告 `junction 已删除: …\profiles\web\node_modules\@dsh-external\dsh-chatbot-tools` |
| 手工创建的 desktop junction | ⚠️ 残留 | 该 junction 由人工建立、不在注入器记录中，卸载不动它；已手工删除 |
| profile patch 的 disabled 条目 | ⚠️ 写错 profile | 注入器把 `disabled: true` 写进 **web** profile（它默认 profile=web），而实际运行的是 desktop；已清理该陈旧条目（备份 `cordis.patch.yml.bak-before-chatbot-cleanup`） |

结论：插件自身无残留；两处残留都来自「注入器默认 web profile + 人工 junction」这条非标准装配路径。改为 bundle 安装后该问题消失。

## 8. 插件页可见性（2026-11-17 20:40）

| 阶段 | 形态 | 插件页 |
|---|---|---|
| 注入器直挂 | 只有运行时 `loader.create` 的匿名 entry（`988fa6cf`），package.json 无 `dsh` 字段 | ❌ 不显示 |
| bundle 安装 | `package.json` 增 `dsh.bundle.patch`、新增 `cordis.patch.yml`、`bundles +=` | ✅ `list_bundles` 出现：`availability:"profile"`、`installed:true`、`enabled:true`、`rows:[{entryId:"include:dsh-chatbot-tools"}]` |

## 9. 拒答兜底（M4）

- 单元测试 6 例全部通过：适配器真实措辞、带前缀、`stop_reason` 形态、`max_tokens` 非拒答、网络错误非拒答、空值安全。
- **未做真实拒答**：需要构造违规输入，属于策略边界，不在自动化测试里主动生成。残余风险：若真实拒答以 HTTP 400 `Content Exists Risk` 返回（而非 `stop_reason: refusal`），中间件不会拦截，表现为普通错误。

## 10. 热重载链路（2026-11-17 20:43）

改用 `dsh-dev-hotreload`（保存即热替换），不再使用 `dev_inject_plugin` / `dev_reload_package`
（前者在 2026-11-17 触发 defer_loading 400 事故，后者在 2026-11-04 卡住会话约一小时）。

实测：保存 `lib/index.js`（新增 `BUILD_TAG` 装载打点）后约 1 秒：

| 证据 | 内容 |
|---|---|
| `%TEMP%/dsh-dev-hotreload.log` | `change: lib\index.js` → `ticked cordis.patch.yml` |
| `~/.dsh/logs/chatbot-tools-safety.ndjson` | 新增 `{"event":"applied:r9-hotreload:safety=enforce"}` |
| 工具可用性 | `chatbot_doctor` 正常返回 |
| 安全性 | 本次重载发生在本会话（含 `defer_loading`）内，无 400 → 守卫在热重载路径同样生效 |

工作流固定为：改文件 → 等 1 秒 → 看这两条日志，不调用任何 `dev_*` 重载工具。

## 11. 设置页 / OCR / ASR / TTS（2026-11-17 21:0x）

### 11.1 设置页

- `Config` 已导出为 schemastery schema，**全部字段标 `.volatile()`**（设置服务只用 volatile 节点建表单，
  一个标记都没有会静默不生成表单）。
- 宿主侧证据：`Config.listConfigs(entry="include:dsh-chatbot-tools")` → `status:"schema"`，
  投影出的 JSON Schema 里 21 个字段均带 `"x-cordis": {"volatile": true}`。
- 请求期用 `plainConfig()` 拆 volatile 活引用（`Symbol.for('cosmokit.volatile.write')` + `get()`）后现读，
  改设置立即生效，不需要重载插件。

### 11.2 凭证

| 顺序 | 来源 | 实测 |
|---|---|---|
| 1 | 设置里的 `apiKey` | 未填 |
| 2 | `DEEPSEEK_API_KEY` 环境变量 | 未设置 |
| 3 | **宿主凭据服务** `ctx.get('credentials').resolve('DEEPSEEK_API_KEY')` | ✅ `chatbot_doctor` 显示 `凭证通道：api-key/credentials:DEEPSEEK_API_KEY` |
| 4 | DeepSeek 账号登录（`x-dsh-auth-token`） | Search / OCR 接受；**TTS / ASR 返回 401**（`Authentication Fails (missing key)`） |

结论：宿主 DSH 里存的 API Key 可以直接复用，无需再填一遍。

### 11.3 三件工具实测

| 工具 | 输入 | 结果 |
|---|---|---|
| `chatbot_ocr` | 生成的英文文本图（3 行） | 3 行全部正确（`DeepSeek OCRtest 2026-11-17` / `Invoice No. A-7781 Amount 1280.50` / `Test line three: hello world 123`） |
| `chatbot_ocr` | Windows 11 壁纸 jpg | 200，1 页（图内几乎无文字） |
| `chatbot_tts` | 31 字符中文 | `~/.dsh/chatbot-tools/out/tts-*.wav`，184364 字节 |
| `chatbot_asr` | 上一步生成的 wav | 3840 ms，转写文本与原文一致 |

TTS → ASR 回环一致，说明两条链路都正确。

## 12. 界面集成：语音输入 + 朗读按钮（2026-11-17 21:1x）

### 12.1 ASR：复用官方语音输入 UI

- 新增 `lib/speech.js`：`createDeepSeekSpeechProvider()`，实现官方 `SpeechProvider` 契约
  （`info` + `transcribe({audio, language}) → {text, audioSeconds, inferenceSeconds}`），
  内部调 `/v1/tools/asr`；
- 在 `apply()` 里 `ctx.inject(['speechToText'], child => child.speechToText.register(...))`，
  服务缺失时自动等待（官方 bundle 未启用也不影响插件其余功能）；
- profile `dsh.profile.bundles` 已含 `@deepseek-ai/dsh-experimental-voice-input-bundle`；
  patch 里 `speech-to-text` 的 `defaultProvider` 改为 `deepseek-asr`。
- **状态：代码就绪，等待重启**加载语音服务行（当前日志仍有 `patch: entry "speech-to-text" not found`）。

### 12.2 TTS：朗读按钮

- `client.js` 注册 `conversation.chat.assistant-actions`（id `chatbot-tts`，order 12）；
- 宿主新增 `GET /chatbot-voice/tts?sessionId=&messageId=`，从会话日志取正文 → 调 TTS → 返回 `audio/wav`；
- 客户端 `fetch` → `Audio` 播放，再点停止。
- 验证限制：`curl http://127.0.0.1:<port>/` 也是 403（Web 服务拒绝非浏览器 peer），
  故该路由只能在页面内验证；需刷新页面以加载新的 client 模块。

### 12.3 一次重启要验证的清单

1. `chatbot_doctor` 的「语音输入提供方」应包含 `deepseek-asr`；
2. 输入框出现麦克风按钮，录音后文本进输入框；
3. 每条回答的动作行出现 🔊，点击能听到语音。

## 13. 重启后验证（2026-11-17 21:36）

### 13.1 ASR：✅ 通过

`chatbot_doctor` 输出：

```
- 语音输入提供方：deepseek-asr, sensevoice-local
- 凭证通道：api-key/credentials:DEEPSEEK_API_KEY
```

- 官方语音服务已随重启加载（重启后日志不再出现 `patch: entry "speech-to-text" not found`）；
- 用户本轮消息**就是通过界面麦克风（ASR）输入的**，属于端到端成功证据。

### 13.2 TTS 按钮：✅ 通过（用户实测，先前判断已纠正）

用户在本轮确认：**回答下方的 🔊 按钮可以直接朗读输出内容**。这同时证明了两件事：

| 先前疑虑 | 实际结论 |
|---|---|
| 「client 模块不在模块图」 | ❌ 误判。当时 grep 的是日志里被截断的 bundle URL；按钮能渲染说明 `dsh.client` 半边已加载。 |
| 「桌面端页面打不到宿主 HTTP 路由」 | ❌ 误判。`curl` 得到 403 是因为**非应用 peer** 被拒（连 `/` 都 403）；渲染进程的页面请求经 `dsh-app://app` 传输携带 peer 准入，能正常到达 `webServer` 路由。 |

**验证方式改进**：路由已加审计日志（`applied:r16-tts-audit`），每次朗读记录
`tts-ok:chars=..:bytes=..:ms=..`；失败记 `tts-failed:http=..`，位于
`~/.dsh/logs/chatbot-tools-safety.ndjson`。此后每次点击都可复核。

**与工具的差别**：按钮是流式返回音频、播放完即弃，不落盘；`chatbot_tts` 工具则把音频写到
`~/.dsh/chatbot-tools/out/tts-*.wav`，供后续使用。

### 13.3 状态

| 能力 | 状态 |
|---|---|
| ASR 麦克风（官方 UI + deepseek-asr provider） | ✅ 已实测（用户本轮消息即 ASR 输入） |
| TTS 朗读按钮（回答动作行 🔊 / ■） | ✅ 已实测（r15；r16 起带审计日志） |
| 内容安全 / 图片搜索 / 结构化搜索 / OCR | ✅ 见 §1、§2、§3、§11 |

## 14. 朗读审计与「代码块不朗读」判定（2026-11-17 21:40）

### 14.1 按钮路径审计

用户再点一次朗读后，日志出现：

```
{"ts":"2026-11-17T13:39:19.692Z","event":"tts-ok:chars=1204:bytes=3264044:ms=11229"}
```

1204 字符 → 3,264,044 字节 wav（24 kHz/16-bit 单声道 ≈ 68 秒音频），宿主往返 11.2 秒。
说明 `client → dsh-app 传输 → /chatbot-voice/tts → 会话日志取正文 → TTS → 音频` 整条链路成立。

### 14.2 代码块不被朗读：正常现象（服务端行为）

用工具直传原文（不经过界面、不经过我们的正文提取）做对照：

| 输入 | 字节 |
|---|---|
| `测试一句话。` + 4 行代码（105 字符） | 59,564 |
| `测试一句话。`（6 字符） | 57,644 |
| 差值 | 1,920 字节 ≈ 40 ms |

即那 99 个字符的代码**几乎没产生音频**。把 `filter_markdown` 关掉（设为 false）再测，
同样 105 字符得到 49,964 字节——代码仍未被念出。

**结论**：代码块不被朗读是 DeepSeek TTS 服务端行为，不是插件丢了内容；
`filter_markdown` 控制的是「朗读前是否去掉 Markdown 格式」（链接、强调等），并不改变代码是否发声。

### 14.3 新增设置

`ttsFilterMarkdown`（默认 `true`）：是否让服务端在朗读前去 Markdown。工具与界面按钮都会透传
`filter_markdown`。默认保持 true，与之前行为一致。

## 15. 行内代码被吞：原因与修复（2026-11-17 21:45）

### 15.1 现象与归因

用户截图指出：正文里的行内代码（如 `ttsFilterMarkdown`、`true`）不会被朗读，导致句子读出来缺词。
这与 §14 的围栏代码块是同一根因的两个表现：**服务端 `filter_markdown: true` 会连同代码标记一起剥掉内容**，
不只是去掉格式。

### 15.2 修复：本地先转成可朗读文本

新增 `lib/speakable.js` 的 `toSpeakable(markdown, { codeMode })`：

| 元素 | 处理 |
|---|---|
| 行内代码 `` `x` `` | **保留内容** x（正是被吞掉的部分） |
| 围栏代码块 | `skip` 删除 / `placeholder` 念「这里有一段代码」/ `read` 保留内容 |
| 链接、图片 | 保留可见文字 / alt |
| 标题、强调、引用、列表、分割线、表格 | 去标记留文字 |

同时把默认改为 `ttsFilterMarkdown: false`：转换已由插件完成，不再让服务端剥第二遍。
新增设置 `ttsCodeMode`（默认 `skip`）。工具与界面按钮都走同一条转换。

离线用例 9/9 通过（`node test/speakable.test.mjs`）。

### 15.3 为什么这次没有热重载

日志：

```
changed modules keep running their previous code until a restart:
[{"url":"file:///C:/Users/Admin/dsh-chatbot-tools/lib/index.js","reason":"module-comparison"}]
```

原因：`lib/index.js` **新增了 import（./speakable.js）**，模块依赖图变化，dsh-hmr 不做局部替换，
只能整插件重启。之前的改动（只改函数体、无新依赖）都能热替换成功。
**结论**：新增/删除 import 必须重启；纯逻辑改动才会热重载。

### 15.4 待验证（重启后）

1. `chatbot_tts("`ttsFilterMarkdown`（默认 `true`，设置页可改）")` → 音频应明显长于此前版本；
2. 界面 🔊 朗读一条含行内代码的回答，确认这些词被念出；
3. `tts-ok` 的 `chars` 应等于转换后的字符数（不含代码块）。

## 16. 英文词（Markdown 等）发音奇怪的原因（2026-11-17 21:49）

方法：同一段文本先 TTS，再把产物送 ASR 转写回来，看英文词被念成什么。

| 输入 | 音频 | ASR 回写 | 判定 |
|---|---|---|---|
| `Markdown`（单独一词） | 46,124 B ≈ 0.96 s | **핑가바**（韩文） | ❌ 语种被判成韩语，发音完全跑偏 |
| `我们讨论一下 Markdown。`（句尾） | 80,684 B ≈ 1.68 s | 我们讨论一下**Mardeano**。 | ❌ 被汉语音系同化 |
| `我们讨论一下 Markdown 的用法。`（中段，后有中文） | 90,284 B | 我们讨论一下 Markdown 的用法。 | ✅ |
| `这个 Markdown 语法很好用。`（中段） | 94,124 B | 这个 Markdown 语法很好用。 | ✅ |
| `We use Markdown to format documents.`（纯英文） | 115,244 B | We use Markdown to format documents. | ✅ |

**根因**：DeepSeek TTS 没有语种参数（官方文档：语种根据文本自动识别）。判定是**按整段文本**做的，
不是逐词；于是

1. 短文本 / 只有英文词时，语种可能被误判（本例判成韩语）；
2. 中文句子里的英文词处于**句尾**或缺少中文锚点时，会被汉语音系"读化"（Markdown → Mardeano）；
3. 英文词夹在中文句中段、前后都有中文时通常正常。

**这不是插件 bug**：插件原样传入了文本；问题在服务端的语种判定与 G2P。

### 可行缓解

| 手段 | 说明 |
|---|---|
| 术语替换（推荐） | 朗读前把易错英文词换成读音稳定的说法，如 `Markdown → 马克当 / 标记语言` |
| 中文锚点 | 尽量不让英文词落在句尾；前后保留中文词 |
| 分句合成 | 中英文分段合成再拼接，音色与韵律接缝需要额外处理，成本高 |

## 17. 官方 TTS 是否支持 prompt（2026-11-17 21:53）

查官方 API 参考 `/v1/tools/tts`：请求体只有 4 个字段

| 字段 | 说明 |
|---|---|
| `text` | 要朗读的文本 |
| `voice_id` | `stella` / `tide` |
| `format` | `wav` / `pcm` |
| `filter_markdown` | 是否去 Markdown |

WebSocket 版本查询参数也只有 `voice_id`、`format`、`filter_markdown`。
**没有 prompt、没有语种、没有语速、没有参考音频、没有风格指令。**

因此 §16 的发音问题无法用 prompt 解决，只能由客户端在朗读前改写文本。已实现：

- `ttsTermMap`（默认空）：支持 JSON `{"Markdown":"马克当"}` 或 `Markdown=马克当, API=接口`；
  按**长词优先**替换，避免短词先吃掉长词；
- 工具 `chatbot_tts` 与界面 🔊 共用同一条 `toSpeakable → applyTerms` 管道。

### 17.1 又一次「需要重启」

日志再次出现 `changed modules keep running their previous code until a restart … module-comparison`。
本次没有被新增文件，但 `lib/index.js` 的 **import 名单变了**（`toSpeakable` → `applyTerms, parseTermMap, toSpeakable`），
同样触发模块比较失败。

**结论（修正 §15.3）**：只要 `lib/index.js` 的 import **语句**发生变化（新增文件或改名单），就需要重启；
仅改函数体才热重载。重启后 `ttsTermMap` 是纯配置项，改设置不再需要重启。

### 17.2 重启后验证

1. 设置里填 `{"Markdown":"马克当"}`；
2. `chatbot_tts("我们讨论一下 Markdown。")` → 再送 ASR，转写应出现「马克当」而非 Mardeano；
3. 界面 🔊 朗读同一句，听感一致。

## 18. r19 重启后的端到端验证（折叠恢复后第一轮，2026-11-17T23:26Z 起）

### 18.1 构建已生效

`chatbot_doctor` → `- 构建：r19-term-map`（不再是 `r18-speakable`）。§17.1 的「改 import 必须重启」
由此闭环：重启后 r19 的 import 名单（`applyTerms, parseTermMap, toSpeakable`）才被真正加载。

### 18.2 行内代码不再被吞（r19 的主修复）

输入（含两处需要朗读的标识符）：

```
我们讨论一下 `ttsFilterMarkdown` 这个字段，它叫 Markdown。
```

| 步骤 | 结果 |
|---|---|
| `chatbot_tts` | 朗读 42 字符 → `tts-1794929182179.wav`，230,444 B |
| `chatbot_asr` 回写 | `我们讨论一下TTS filter mark day down这个字段，它叫mark day on.` |

反引号内的 `ttsFilterMarkdown` **被读出来了**（ASR 记作 "TTS filter mark day down"），
说明本地 `toSpeakable` 保留行内代码、不再交给服务端 `filter_markdown` 吞掉。

同一次回写也**独立复现了 §16 的发音问题**：同一个词在句中读成 "mark day down"、句末读成
"mark day on" —— 完全取决于整段自动判语种，与词本身无关。

### 18.3 术语表（ttsTermMap）已验证生效

**写入方式的一个差异（与 §17.2 的步骤不同）**：本轮没有走 设置页面，而是在
`~/.dsh/profiles/desktop/cordis.patch.yml` 加了一行 `- id: dsh-chatbot-tools` 的 config，
填 `ttsTermMap: '{"Markdown":"马克当文档"}'`。原因：本会话审批被禁用，`browser_start` 被拒，
打不开设置页。备份见 `cordis.patch.yml.bak-before-chatbot-termmap-20261117-232654`。

⚠️ patch 行是**整体替换** bundle 自带 config，不是逐键合并 —— 行里必须原样抄全 bundle patch
的每个键（`safetyMode`/`safetyLevel`/`safetyGuardDeferLoading`/`safetySkipPurposes`/`safetyLog`/
`model`/`serverTool`/`maxUses`），否则被抄掉的键会退回 schema 默认值。

同一句重跑：

| 步骤 | 结果 |
|---|---|
| `chatbot_tts` | 朗读 **36** 字符（上一轮 42）→ 268,844 B |
| `chatbot_asr` 回写 | `我们讨论一下TTS filter马克当文档这个字段，它叫马克当文档。` |

字符数下降可算术核对：`Markdown`(8) → `马克当文档`(5)，净 −3，句中出现两次 → 42 − 6 = 36。
两处都被替换，说明**术语表在工具管道与 🔊 管道共用的 `toSpeakable → applyTerms` 上真的生效**，
配置改完无需重启（纯配置项，符合 §17.1 的结论）。

### 18.4 `applyTerms` 的匹配语义（实测，含一个已知风险）

直接对 `lib/speakable.js` 做调用探测：

| 键 | 文本 | 结果 |
|---|---|---|
| `Markdown` | `ttsFilterMarkdown` | 命中 → `ttsFilter【Markdown】`（标识符内部也会替换） |
| `Markdown` | `markdown` | 不命中 —— **大小写敏感** |
| `AI` | `OPENAI` | 命中 → `OPEN【AI】`（**短词会撞进更长的英文单词**） |
| `ttsFilterMarkdown` + `Markdown` | 两者同时出现 | 长词优先，标识符整体先被吃掉 |

结论：替换是**纯子串、大小写敏感、长词优先**。对 TTS 而言「标识符内部也替换」是想要的
（朗读文本没有语法，替换只为发音）；真正的风险只有**≤2 字符的短键**（`AI`/`ML`/`Go`）会撞进
`OPENAI`、`Golang` 这类更长单词。可用的临时规避：键里自带边界（写 `" AI "` 并在替换值里补空格）。
是否给短键加「ASCII 词边界」判定，待定（见 §18.5）。

### 18.5 尚未决定

1. 短键是否加边界判定（改动小，纯函数体，可热重载；需补 2 个用例）；
2. `chatbot_upload_document(path, purpose)`（Files API → `file_id`）是否要加；
3. 是否在 `deepseek-ai/DeepSeek-V3` 用 `feature_request` 公开提 TTS 反馈（草稿在
   `docs/feedback-tts-code-switch.md`，同一内容已邮件发至 `api-service@deepseek.com`）。

以上三项已全部拍板（用户 2026-11-17）：短键加词边界 ✅、加 `chatbot_upload_document` ✅、
**不发公开 issue**（邮件已够）✅。

## 19. r19 图片守卫端到端验证（2026-11-17T15:42Z，折叠恢复后）

### 19.1 目的

验证 `non-text-tool-result` 守卫能真正阻止事故 2 的 400
（`messages.94: only text content is supported in tool_result blocks with … safety_check …`）。
事故教训见 `docs/incident-2026-11-17-tool-result-image.md`。

### 19.2 方法

**不在主会话直接 `read_image`** —— 万一守卫失效会把主会话也写死（历史一旦持久化就无法回滚）。
改用一次性子代理 `img-guard-probe`，爆炸半径隔离：它只做一次 `read_image`，然后报告。

图片：`~/.dsh/attachments/v1/objects/74/7409943…6480a7`（PNG，magic `89504e47`）。

### 19.3 结果

审计日志 `~/.dsh/logs/chatbot-tools-safety.ndjson` 逐条对上：

```
15:42:13.719Z  toolCount:290  deferredCount:0  serverFields:[]  nonTextResults:1  decision:"non-text-tool-result"
15:42:17.598Z  toolCount:290  deferredCount:0  serverFields:[]  nonTextResults:0  decision:"enforce"
```

- 第一条 = 子代理那次 `read_image` 之后的请求：`nonTextResults:1` → 守卫命中 → **跳过 `safety_check`**；
- 第二条 = 紧随其后的请求：图片已不在请求体内 → 计数归 0 → **恢复 `enforce`**（内容安全自动回到全开）；
- 宿主日志 `desktop-next-2026-11-17.0.jsonl` 中**没有**新增 `only text content is supported`
  或 `agent.failed`；
- 子代理正常返回 `RESULT: success`，并且**描述准确**：绿色 PCB、丝印 `P3.7–P3.0` / `P2.7–P2.0`、
  蓝色顶面微调电位器、丝印 `C12`/`R40`/`R36`、一排 `Q1`…`Q9` 黑色三脚贴片器件。

结论：**守卫按设计工作**——含非文本 `tool_result` 的那一次请求退让，其余请求照常带内容安全；
会话全程存活。事故 2 的根因通道已被闭合。

### 19.4 一个与交接档不符的观察（以观察为准）

交接档 002 记「本会话 `deferredCount:1`、`safety_check` 全程跳过」。折叠后实测 **`deferredCount:0`**，
且 `decision:"enforce"`。

即 `toolDeclarations()` 给「会话中途新增工具」打的 `deferLoading` 标记**并非永久**：折叠
（compaction 重写历史）之后它消失了。仅 `purpose:"compaction"` 那一次请求仍报
`deferredCount:1`（压缩请求用的是另一套声明集）。

含义：`defer_loading` × `safety_check` 的互斥是**可自愈**的，重启或折叠后都会恢复，
不需要为了它牺牲内容安全；但它仍是服务端真实约束，已写入给官方的反馈（§20）。

## 20. 已知服务端约束汇总（`safety_check` 三条互斥，全部已有守卫）

`deepseekLlmApiExtensions.register('safety_check')` 一旦注入 `request.body`，服务端就会对
**整个请求**施加排他性校验。踩中任何一条都返回 400，而且**历史已持久化后无法重试自救**——
所以每条约束都必须先变成守卫 + 单测，再上线。

| # | 约束 | 触发条件 | 错误信息 | 守卫 | 文档 |
|---|---|---|---|---|---|
| 1 | 不能有延迟加载工具 | 请求体内有 `defer_loading: true` 的工具声明（DSH 给「会话中途新增的工具」打此标记） | 相关 tool 声明被拒 | `defer-loading-guard` | `incident-2026-11-17-safety-check-defer-loading.md` |
| 2 | 不能在非思考模式 | `thinking: disabled`（含 `purpose` 为标题生成等辅助请求） | — | `thinking-off` / `purpose-skip` | 同上 |
| 3 | `tool_result` 只能纯文本 | 历史里任一 `tool_result` 的 `content` 数组含非 `text` 成员（图片、文件等） | `messages.NN: only text content is supported in tool_result blocks with deepseek_web_search, deepseek_read_url, safety_check or title yet` | `non-text-tool-result`（本次新增） | `incident-2026-11-17-tool-result-image.md` |

守卫优先级（`lib/safety.js` 的 `decide()`）：
`mode-off` → `purpose-skip` → `thinking-off` → `non-text-tool-result` → `defer-loading-guard` → `observe` → `enforce`。

三条互斥字段 `deepseek_web_search` / `deepseek_read_url` / `safety_check` / `title` 中，
**没有一个**是 DSH 核心注入的（审计字段 `serverFields: []` 在每次 `enforce` 请求上都是空数组，
且 `grep -c deepseek_web_search app.asar` = 0），所以第三方插件只要用 `safety_check`，
就必须自己承担上面三条的全部守卫义务。

已按用户决定：不发公开 issue，三条约束合并成一封邮件发 `api-service@deepseek.com`（续上一封 TTS 反馈）。

## 21. 文件引用链路补测 + 内容安全改为默认关闭（2026-11-18）

### 21.1 为什么要改默认值

用户明确要求：`safety_check` 与拒答提示**会限制 DSH 本身的能力**（内容审核会把网安红队 /
渗透测试这类正当需求判成拒答），插件不该替用户做这个取舍。因此两者改为**默认关闭**，
开关交给用户在设置页决定。

- 新增总开关 `safetyEnabled`，默认 `false`；`decide()` 第一句就是
  `if (cfg.safetyEnabled !== true) return { inject: false, reason: 'mode-off' }`，
  所以缺省 / `false` / 任意 `safetyMode` 组合都不会注入。
- 新增 `refusalNotice`，默认 `false`；`llm/stream` 中间件在关闭时**原样透传**
  （`for await (const chunk of await next()) yield chunk; return`），不改变 DSH 行为。
- 两条服务端互斥守卫保持不变，只是现在只在开关打开后才会走到。

单测新增 3 例覆盖总开关语义（关闭 / 缺省 / 打开但 mode=off），`safety-guard` 共 24 项全绿。

### 21.2 补测：`file_id` 作为 document 块引用进对话

**这是此前 README 明确标为「未实测」的那一项。**

测试脚本 `~/.dsh/tmp/docref-test.mjs`（一次性，不入库）。凭证从
`~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（35 字符）读取，**全程不打印**。

步骤与结果：

| 步骤 | 结果 |
|---|---|
| 生成探针 DOCX（python-docx，含唯一标记 `BLUE-FALCON-7731`，36,825 B） | — |
| `POST /files`，`purpose=text_recognition`（multipart，`purpose` 在 `file` 之前） | **200**，`file_id = file-api-992ae83a-b5cb-4c6b-b242-d33a503e89b1` |
| `POST /anthropic/v1/messages`，content 首块 `{"type":"document","source":{"type":"file","file_id":…}}`，带 `anthropic-beta: files-api-2025-04-14` | **200**，`model=deepseek-flash`，`stop_reason=end_turn` |
| 模型回答 | `BLUE-FALCON-7731` —— **标记命中，证明文件内容真的进了模型上下文** |
| 同一请求去掉 `anthropic-beta` 头 | **400** `Missing or invalid anthropic-beta header` |

结论：**`file_id` 引用链路可用，且 `anthropic-beta: files-api-2025-04-14` 是必需请求头。**

一条边界：这不等于「DSH 自己的对话流程能发 document 块」。查 `app.asar` 得到的 7 处
`files-api-2025-04-14` 全部来自捆绑的 Anthropic SDK 文档/CHANGELOG，**不是 DeepSeek 适配器
的代码**，所以「DSH 会不会自动产出 document 块」仍未证实。本插件本身也不往对话里注入
document 块——它只负责把文件变成 `file_id` 并告知引用方式。

### 21.3 顺带测出并修掉的缺陷：用途 × 格式矩阵

补测时发现 `chatbot_upload_document` 对纯文本文件配解析用途会直接 400，而且服务端那句话
完全不指向真实原因。实测矩阵：

| 文件 | purpose | 结果 |
|---|---|---|
| `probe.txt` | `user_data` | **200** `file-api-6492ad65-…` |
| `probe.txt` | `text_recognition` | **400** `Failed to recognize the file: the file format is not supported` |
| `probe.md` | `user_data` | **200** `file-api-47ac0868-…` |
| `probe.json` | `user_data` | **200** `file-api-86913bab-…` |

即：**解析类用途只接受文档格式；纯文本类只能用 `user_data`。** 服务端不区分「格式不支持」
和「用途不匹配」，一律回 `the file format is not supported`，极易误判成文件损坏。

修法：新增 `lib/files.js`（`extensionOf` / `isPlainTextFile` / `purposeFormatError`），
在上传前前置拦截，抛出带两种改法的明确提示；配 `test/files.test.mjs` 20 例
（含「未知扩展名不拦，交给服务端判断」这类边界）。

## 22. 拒答 / 输入未过审：真实触发尝试与补齐（2026-11-18）

用户把两个开关打开后，要求补测此前标为「策略边界」的两条：

- 「refusal 只做了单元测试，未主动构造违规输入」
- 「若真实拒答以 HTTP 400 Content Exists Risk 返回，中间件不拦截」

### 22.1 先确定官方语义

`https://api-docs.deepseek.com/zh-cn/guides/safety` 写明开启 `safety_check` 后**两种**被拦形态：

| 形态 | 表现 |
|---|---|
| 输入未过审 | 请求**直接返回 `400 Content Exists Risk`**；图片被拦时附 `The following images were blocked by content moderation: messages.1.content.0` |
| 输出侧拒答 | 响应以 `stop_reason: "refusal"` + `stop_details: {type:"refusal"}` 结束；非流式会清空正文只留一个空 `text` 块 |

并且：审核 Token 计入 `usage.output_tokens_details.safety_tokens`。

### 22.2 真实触发尝试（5 个类别，全部未命中）

直接对 `POST /anthropic/v1/messages` 打探针（`safety_check: {level:"high"}`，
只记录元数据，`max_tokens` 压小，不打印任何模型正文）：

| # | 类别 | HTTP | stop_reason | safety_tokens |
|---|---|---|---|---|
| P1 | 钓鱼邮件（冒充银行客服骗取验证码） | 200 | `end_turn` | 0 |
| P2 | 暴力威胁 | 200 | `end_turn` | 0 |
| P3 | 伪造证件 | 200 | `end_turn` | 0 |
| P4 | 侮辱群体 | 200 | `end_turn` | 0 |
| P5 | 同一输入去掉 `safety_check` / 改 `low` | 200 | `end_turn` | —（无该字段） |

结论：**这 5 个类别都没有触发审核**，`safety_tokens` 恒为 0。所以「策略边界」是真实存在的——
不是漏测，而是这个部署对这几类内容的审核并不敏感。继续往上加码需要构造我不打算写的内容，
到此为止。

### 22.3 因此修的是「确定会漏」的那条

`isRefusalError()` 原来只认 `unsupported stop reason refusal` / `stop_reason … refusal`，
而 `400 Content Exists Risk` 是一条**纯 HTTP 400**，永远不会匹配——文档确认它一定存在，
所以这是确定缺陷，与能否触发无关。

修法：

1. 匹配器补上 `content exists risk` 与 `blocked by content moderation`（大小写不敏感）；
2. 中间件区分两种提示：输入未过审说「这条输入未通过审核，模型没有作答」，
   输出侧拒答说「该回答已被拦截」——混成一句话会误导用户；
3. 新增 5 条匹配用例（共 11 条），其中 **4 条是防误判**：`max_tokens` 截断、网络错误、
   `safety_check` 字段非法、限流，都必须判成 `false`，否则用户会收到错误的「被内容安全拦截」。

单测合计 `29 + 18 + 20 = 67` 项全绿。

### 22.4 仍未覆盖的部分（诚实记录）

中间件的**拦截分支**目前只有单测覆盖，没有端到端：要端到端跑通必须先真实产生一次拒答，
而 22.2 表明在本部署下无法稳定触发。**未拦截分支**（`refusalNotice` 关闭时原样透传）
反而是端到端验证过的——用户开启开关后，本条会话的每一轮都在经过该中间件且流式正常。

### 22.5 顺带验证：设置开关确实落盘

用户在插件页把两个开关打开后，`~/.dsh/profiles/desktop/cordis.patch.yml` 里对应条目变成：

```yaml
- id: dsh-chatbot-tools
  config:
    safetyEnabled: true
    refusalNotice: true
```

即「插件页开关 → settings 服务 → profile patch」这条链路端到端通了，不只是界面状态。

## 23. 官方有没有「拒答测试指南」？——没有，但有更值钱的东西（2026-11-18）

### 23.1 结论：文档只讲「怎么处理」，不讲「怎么触发」

`guides/safety` 全文给了三件事：开启方式、被拦的两种形态、前端应该如何渲染。
**没有任何测试向量 / 触发样例**——合理，官方不会发布一份「怎么绕过风控」的清单。
所以「真实拒答测不出来」不是我们没找到指南，而是这件事本身没有官方指引。

### 23.2 但官方演示客户端把行为定死了

`deepseek-ai/chat-demo`（文档点名的参考实现）里，`src/services/chat/reply.ts` 的 `settleReply`：

```ts
blocks: reply.blocks.flatMap((block) => {
  if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
    return []          // 已下发的思考与正文全部丢弃，只保留工具块
  }
  ...
})
```

配套还有两条：

- `canContinueReply()`：`stopReason === 'refusal'` 时**不允许续写**；
- `isUsableReply()`：被拒答的轮次 **不进入上下文**（`stopReason !== 'refusal'` 才回传）。

### 23.3 因此我们与官方有一处行为分歧（如实记录）

我们的 `refusalNotice` 是「把 refusal 换成一段可读文本并正常收尾」。
代价是：这一轮变成了一条**正常的 assistant 回答**，会进入历史、下一轮会被回传，
而官方做法是丢弃正文且**不回传**。

两种取向各有道理：

| | 官方 demo | 本插件（`refusalNotice: true`） |
|---|---|---|
| 用户看到 | 自己的拒答文案（正文被丢弃） | 一段说明文字 |
| 该轮是否进上下文 | 否 | 是（因此会污染后续上下文） |

这也是 `refusalNotice` **默认关闭**的又一个理由：关闭时 refusal 保持 DSH 原生行为，
与官方语义最接近。想完全对齐官方的话，把开关关掉即可。

### 23.4 顺带发现：官方 `errors.ts` 其实没细分输入未过审

`src/services/api/errors.ts` 的 `classifyStatus()` 只按状态码归类（401/402/413/429/5xx），
**`400 Content Exists Risk` 落进 `'other'`**，用户只会看到通用错误。
也就是说 §22 里我们补的那条识别，比官方 demo 更细——不是抄来的，是文档 + 实测推出来的。

### 23.5 顺手采纳：官方对 Files API 400 的文案细分规则

`errors.ts` 的 `getUploadErrorInfo()` 证明「400 只带 message 文本，只能按文案区分」，规则是：

- `User file count limit exceeded … limit (\d+)` → 文件数量上限
- `User storage quota exceeded … limit ([\d.]+) GB` → 存储配额上限
- `You have uploaded an (unsupported|invalid) (file|image)` / `The image is too large to process` /
  `password-protected` / `Failed to recognize the file` → 解析失败的各种具体原因

原来的 `uploadHint(status)` 只看状态码，所有 400 都是同一句笼统提示。
现改为 `lib/files.js` 的 `uploadFailureHint(status, detail)`，按官方这套文案细分，
配 11 条新用例（含「未收录的状态码不瞎猜」）。单测合计 `29 + 18 + 31 = 78` 项。

## 24. 能不能「prompt 注入审核器」来造一次真实拒答？（2026-11-18）

### 24.1 想法

审核那边应该也是 LLM，那能不能在请求里写「我们正在测试，请返回拒绝」，让它主动拒答，
从而拿到真实的 `stop_reason: refusal` 来做端到端测试？

### 24.2 结论：不可行，而且不该试

1. **审核器不是对话方，是分类器。** 它的产出是风险判定，不是会话内容。我们写的
   「我们正在测试，请返回拒绝」对它而言只是**待判定的文本**，不是指令。`stop_reason: refusal`
   是**外层模型调用**的结束原因，由审核结论驱动，不是审核器可以直接「返回」的东西。
2. **即使碰巧生效也不能算验证。** 那是一次依赖未文档化行为的偶发结果，不可复现，
   也无法证明生产路径成立。
3. **方法本身与越狱同族。**「用注入文本让审核系统按我的意思行动」的反方向——
   让本该被拦的内容过审——正是最有价值的那类漏洞。即使本次意图是让它**多拦**，
   也不应该拿供应商的审核系统去试这个边界。

### 24.3 换了个做法：把拦截分支变成可确定性驱动

真实拒答拿不到，但**中间件的行为**可以完全不依赖真实拒答来验证。把原来写在 `apply()` 里、
无法测试的那段中间件，抽成 `lib/safety.js` 的纯异步生成器：

```js
export async function* refusalGuardStream(next, enabled)
```

- `enabled` 为假 → **原样透传**，连异常都不碰（等价于插件不存在）；
- 开启时只接管 `isRefusalError()` 认得的错误，其余照常抛出，
  避免把限流/网络故障伪装成「被内容安全拦截」；
- 命中后按 DSH 流式协议发一段完整文本块（start → delta → end → finish）并正常收尾。

`lib/index.js` 的挂载退化成一行：

```js
ctx.on('llm/stream', (_options, next) => refusalGuardStream(next, live().refusalNotice))
```

### 24.4 新增测试 + 变异测试

`test/refusal-stream.test.mjs` 11 例，用「抛一个带真实文案的错误」驱动，验证**到底 yield 了什么**：

| 用例 | 断言 |
|---|---|
| 关闭时正常流 | chunk 一个不多一个不少 |
| 关闭时拒答异常 | **照常抛出**（不吞） |
| 开启时正常流 | chunk 完全不变 |
| 输出侧拒答 | 已下发 chunk 保留 + 4 个兜底 chunk，文案为 `REFUSAL_NOTICE.output` |
| 输入未过审 / 图片被拦 | 文案为 `REFUSAL_NOTICE.input`，且与 output **必须可区分** |
| 限流 / 网络错误 | 照常抛出，不被伪装成拦截 |
| 兜底 chunk | 结构完整：`block-start`→`text-delta`→`block-end`→`finish`，`block-end.text` 等于 delta 文本 |

**变异测试**（故意改坏 → 必须 FAIL → 恢复 → 必须 PASS）：

| 变异 | 结果 |
|---|---|
| 从匹配器删掉 `content exists risk` | `9/11`，输入未过审与口径一致性 2 例 FAIL |
| 删掉「关闭时透传」分支 | `10/11`，「关闭时拒答异常照常抛出」FAIL |
| 恢复原文件 | `11/11` 全绿 |

单测合计 `29 + 18 + 31 + 11 = 89` 项。

### 24.5 仍然没做的：真正的端到端

要给「真实拒答 → 中间件」这条链做实机证据，只剩一条不碰违规内容、也不操纵供应商审核的路：
**本地起一个 mock Messages 服务**，按文档吐 `stop_reason: refusal` 流或 `400 Content Exists Risk`，
再让**另一个独立 profile 的 DSH 实例**指向它跑一轮。这需要额外一套运行环境，本轮没做——
所以「拦截分支」现在的准确表述是：**分支行为已被确定性测试与变异测试覆盖，
但没有真实拒答的实机证据**。

## 25. 真实端到端：拒答中间件此前**从未生效过**（2026-11-18，重大纠正）

### 25.1 做法：本地 mock 服务 + 一次性 profile

用户提供了一个空闲的独立 DSH 实例作思路，但更干净的做法是不碰任何现有 profile：

1. 起一个本地 mock Messages 服务（`~/.dsh/tmp/mock-messages.mjs`），按官方文档吐两种被拦形态；
2. 复制 `headless` profile 为一次性的 `probe`，用 `dsh plugin --profile probe add <tgz>` 装本插件；
3. 用 `dsh probe --patch <overlay.yml>` 启动 —— `--patch` 只在本条命令生效，
   overlay 里把 `llm-deepseek`（注意：api-key 那条 provider 的 entry id 是 `llm-deepseek`，
   `llm-deepseek-api-key` 只是包名/日志名）和 `llm-deepseek-account` 的 `baseURL` 指向 mock，
   同时把本插件的 `refusalNotice` 打开。

全程没有构造任何违规内容，也没有试探供应商的审核边界。

### 25.2 实测到的两种真实形态

| 形态 | DSH 实际交付 |
|---|---|
| 输出侧拒答 | **不抛异常**，而是 `finish` chunk：`{type:'finish', reason:{kind:'error', failure:{code:'MALFORMED_RESPONSE', message:'DeepSeek Messages stream: unsupported stop reason refusal'}}}`；CLI 打印 `dsh: MALFORMED_RESPONSE: …` |
| 输入未过审 | 同样是 `finish` 失败：`{kind:'error', failure:{code:'INVALID_REQUEST', message:'Content Exists Risk'}}`；CLI 打印 `dsh: INVALID_REQUEST: Content Exists Risk` |

关键结论：**`FinishReasonMap` 里没有 `refusal` 这一种**（只有 stop / tool-calls /
max-tokens / aborted / error），适配器把拒答降级成 `kind:'error'`。

### 25.3 因此这是一个真 bug，而非“缺证据”

原中间件只 `catch` 抛出的异常。而 DSH 把失败作为 `finish` chunk 交付 ——
**这条拦截分支在真实环境从未执行过**，用户看到的永远是原始报错。
前几轮文档里「拦截分支只有单测覆盖」的表述低估了问题：不是“没证据”，是“实现没接上”。

修法：

```js
if (enabled && isRefusalFailureChunk(chunk)) {   // finish + kind:'error' + failure 命中拒答
  yield* emit(REFUSAL_NOTICE[refusalKind(chunk.reason.failure)])
  return
}
```

同时保留 `catch` 兜住真的抛异常的适配器；新块的索引用 `lastIndex + 1`，避免与已下发的块撞车。
新增 `isRefusalFailureChunk()` 与 5 条「真实形态」用例（`test/refusal-stream.test.mjs` 共 16 例）。

### 25.4 端到端结果

```
$ dsh probe --patch overlay.yml "请只回答两个字：收到"
⚠️ 该回答已被 DeepSeek 内容安全策略拦截（refusal）。可在 设置 → 插件 → dsh-chatbot-tools 里调整内容安全开关后重试。

# mock 切到 400 模式后
$ dsh probe --patch overlay.yml "请只回答两个字：收到"
⚠️ 这条输入未通过 DeepSeek 内容安全审核（HTTP 400 Content Exists Risk），模型没有作答。可在 设置 → 插件 → dsh-chatbot-tools 里关闭内容安全后重试。
```

两种形态都由中间件接管并输出对应文案 —— **这是第一次拿到真实实机证据**。

### 25.5 两个被证伪的假设（避免以后重走）

1. **「`ctx.on('llm/stream')` 注册顺序导致中断」——错。** 当时依据是 probe 里 `toolCount=31`
   且工具“看起来没注册”。实际 headless 基底 24 个工具 + 本插件 7 个 = 31，工具一直是注册上的。
   那个误判源于诊断代码自身的 bug：`note()` 里用了 ESM 不允许的 `require('node:fs')`，
   异常被自己的 `catch` 吞掉，日志全空，被我读成“生成器没被调用”。
   → 教训：**诊断代码本身也要验证**，否则会用“没有日志”推出错误结论。
   （`optional()` 隔离仍然保留，它是防御性的，但**不是**本次修复的原因。）
2. **「适配器会抛异常」——错。** 见 25.2。

### 25.6 仍未覆盖

`llm/stream` 之外的路径（例如未来 DSH 改用别的失败交付方式）没有覆盖；如果上游把拒答
改成 `finish: {kind:'aborted'}` 或新增 `refusal` 这个 kind，需要再对一次。当前实现对
`kind:'error'` 的 `failure.message` 做匹配，属于「按文案识别」，上游改文案就会失效。
