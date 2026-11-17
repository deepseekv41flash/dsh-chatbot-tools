# Changelog

本文件记录本插件的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-18

### 修复（重要：拒答兜底此前从未生效）

- **拒答中间件只 `catch` 抛出的异常，但 DSH 并不抛异常。** 端到端实测（本地 mock Messages
  服务 + 一次性 profile）发现：适配器把失败作为 `finish` chunk 交付——
  `{type:'finish', reason:{kind:'error', failure:{code:'MALFORMED_RESPONSE',
  message:'DeepSeek Messages stream: unsupported stop reason refusal'}}}`，
  输入未过审则是 `{code:'INVALID_REQUEST', message:'Content Exists Risk'}`。
  `FinishReasonMap` 里根本没有 `refusal` 这一种。
  因此这条分支在真实环境**一次都没执行过**，用户看到的永远是原始报错。
- 现改为同时识别 `finish` 失败 chunk（`isRefusalFailureChunk()`），命中后用提示替换该 chunk；
  同时保留 `catch` 兜住真抛异常的适配器。新块索引用 `lastIndex + 1`，不与已下发的块撞车。

### 测试

- `test/refusal-stream.test.mjs` 扩到 16 例，新增 5 例覆盖**真实形态**（finish 失败而非抛异常）。
- 单测合计 `29 + 18 + 31 + 16 = 94` 项。

### 验证

- 端到端（`dsh probe --patch overlay.yml`，overlay 把 provider 指向 mock）：
  - 拒答模式 → `⚠️ 该回答已被 DeepSeek 内容安全策略拦截（refusal）…`
  - 400 模式 → `⚠️ 这条输入未通过 DeepSeek 内容安全审核（HTTP 400 Content Exists Risk）…`
- 全程未构造任何违规内容，也未试探供应商的审核边界。经过见 `docs/verification-2026-11-17.md` §25。

### 硬化

- 可选服务（`deepseekLlmApiExtensions` / `speechToText` / `webServer`）的注册各自隔离，
  任何一步失败都记 `optional-failed:<label>` 而不中断 apply。
  （说明：这不是本次拒答失效的原因——`toolCount` 证明工具一直注册成功；
  保留它是防御性的，见 §25.5。）

## [0.3.3] - 2026-11-18

### 重构（可测性）

- 拒答中间件从 `apply()` 里抽成 `lib/safety.js` 的纯异步生成器 `refusalGuardStream(next, enabled)`。
  原因是真实拒答极难触发（§22），逻辑留在闭包里就永远只能「看代码推断」。
  `lib/index.js` 的挂载退化成一行。

### 新增测试

- `test/refusal-stream.test.mjs` 11 例，用「抛一个带真实文案的错误」确定性驱动，
  验证**它到底 yield 了什么**：关闭时原样透传、拒答异常不得被吞、输出侧拒答追加提示、
  输入未过审用不同文案、限流与网络错误不得被误判成拦截、兜底 chunk 结构完整。
- 做过**变异测试**：删掉匹配器里的 `content exists risk` → 2 例 FAIL；
  删掉「关闭时透传」分支 → 1 例 FAIL；恢复 → 全绿。
- 单测合计 `29 + 18 + 31 + 11 = 89` 项。

### 文档

- `docs/verification-2026-11-17.md` §24：说明为什么「prompt 注入审核器让它主动拒答」
  这条路不可行也不该试（审核器是分类器不是对话方；不可复现；方法与越狱同族），
  以及唯一可行的实机验证方案（本地 mock Messages 服务 + 独立 profile 实例）尚未做。

## [0.3.2] - 2026-11-18

### 改进

- **Files API 上传失败按文案细分**。原 `uploadHint(status)` 只看状态码，所有 400 都是同一句笼统提示；
  现改为 `uploadFailureHint(status, detail)`，规则取自官方演示客户端
  `deepseek-ai/chat-demo` 的 `src/services/api/errors.ts`：文件数量上限、存储配额上限、
  不受支持/损坏、图片过大、有密码保护、无法解析。新增 11 条用例。

### 文档

- 新增 `docs/verification-2026-11-17.md` §23：官方**没有**拒答触发指南（只讲怎么处理），
  但官方 demo 把行为定死了——`settleReply` 在被拒答时丢弃思考与正文、只保留工具块，
  `canContinueReply` 禁止续写，`isUsableReply` 让被拒答的轮次**不进上下文**。
- 据此记录一处行为分歧：本插件的 `refusalNotice` 会把拒答变成一条正常回答并进入上下文，
  与官方语义不同。这也是它默认关闭的又一个理由。

## [0.3.1] - 2026-11-18

### 修复

- **`400 Content Exists Risk` 不再被当成普通错误**。官方文档
  <https://api-docs.deepseek.com/zh-cn/guides/safety> 写明开启 `safety_check` 后，输入未过审
  会直接返回 `400 Content Exists Risk`（图片被拦时附 `The following images were blocked by
  content moderation: …`），而原匹配器只认 `stop_reason: refusal`，这条必然漏。
- 中间件现在区分两种提示：输入未过审说「这条输入未通过审核、模型没有作答」，
  输出侧拒答说「该回答已被拦截」——混成一句话会误导用户。
- 新增 5 条匹配用例（共 11 条），其中 4 条是防误判：`max_tokens` 截断、网络错误、
  `safety_check` 字段非法、限流，都必须判成「不是拒答」。

### 变更

- **设置页真的有界面了**。此前 README 说「设置页可调」，实际上 DSH **不会**拿插件 `Config`
  schema 自动生成表单：配置 UI 必须由插件客户端注册进 `plugins.bundle.config`
  （key = 包名）或 `plugins.row.config`（key = `<包名>#<行 id>`）。`client.js` 现已注册配置卡片，
  经 `ctx.remote.settings.describe/mutate` 读写，写入落 profile patch（volatile，改完立即生效）。
  实测：打开两个开关后 `cordis.patch.yml` 里出现 `safetyEnabled: true` / `refusalNotice: true`。

### 验证

- 真实拒答**仍未能触发**：5 个类别（钓鱼、暴力威胁、伪造证件、侮辱群体、无 `safety_check` 对照）
  全部 200 + `end_turn` + `safety_tokens: 0`。因此拦截分支只有单测覆盖，透传分支已端到端验证。
  证据与探针记录见 `docs/verification-2026-11-17.md` §22。
- 单元测试扩到 `29 + 18 + 20 = 67` 项。

## [0.3.0] - 2026-11-18

### 变更（破坏性默认值）

- **内容安全改为默认关闭**。新增总开关 `safetyEnabled`（默认 `false`）。关闭时完全不注入
  `safety_check`，插件对 DSH 能力零影响。理由：内容审核会拒掉网安红队/渗透测试这类正当需求，
  这个取舍不该由插件替用户做。`safetyMode`（`off`/`observe`/`enforce`）保留，仅在总开关打开后生效。
- **拒答提示改为默认关闭**。新增 `refusalNotice`（默认 `false`）。关闭时 `llm/stream` 原样透传，
  完全保持 DSH 的原始行为；开启后才把 refusal 抛错换成可读提示。
- 两条服务端互斥守卫不变，但只在 `safetyEnabled: true` 时才会走到。

### 新增

- `lib/files.js` + `test/files.test.mjs`：Files API「用途 × 文件格式」兼容性判定。
  实测发现解析类用途只接受文档格式，纯文本（txt/md/json/csv…）只能用 `user_data`，
  而服务端只回一句含义不清的 `the file format is not supported`。现在插件前置拦截并给出可执行建议。

### 修复

- `chatbot_upload_document` 不再把「用途与格式不匹配」的含糊报错直接丢给模型。

### 验证

- 补测文档引用的未测项：DOCX 上传（`text_recognition`）→ 以
  `{"type":"document","source":{"type":"file","file_id":…}}` 引用进 Messages → 模型准确答出
  文档内唯一标记；确认 `anthropic-beta: files-api-2025-04-14` 为必需请求头。
- 单元测试扩到 `24 + 18 + 20` 项（新增总开关 3 例、格式判定 20 例）。

## [0.2.2] - 2026-11-18

### 修复

- 去掉 listed 徽章（等 dsh-plugin.org 收录后由作者自行补上）。
- 徽章改用无 `.svg` 后缀的等价 URL。原因：shields.io 按 URL 缓存徽章 **4 小时**
  （`cache-control: max-age=14400`），而首次抓取时 `latest` 还指向 npm staged-publish 的
  占位版本 `0.0.0-stage`（该版本没有 `license` 字段），于是 README 上一直显示
  `license: missing` / `npm: v0.0.0-stage`。换 URL 即换缓存键，立即恢复正常。

## [0.2.1] - 2026-11-18

纯文档补丁，让 npm 页面与仓库保持一致。

### 变更

- README 顶部对齐本账号其他插件格式：语言切换行 + listed / npm / license 三枚徽章 + 引用块摘要。
- 英文版拆到独立的 `README-en.md`（原先内联在 `README.md` 底部），两份互加语言切换链接。
- `package.json` 的 `files` 增加 `README-en.md`。

## [0.2.0] - 2026-11-18

首个公开发布版本。

### 新增

- **内容安全**：通过 `deepseekLlmApiExtensions` 注册 `safety_check`，可在设置页调
  `safetyMode`（`off` / `observe` / `enforce`）与 `safetyLevel`（`high` / `low`）。
  实测发现服务端会对整个请求施加 **3 条排他约束**，每条都实现为守卫并配单元测试：
  - `non-text-tool-result` —— 历史中 `tool_result` 含图片等非文本块时跳过注入；
  - `defer-loading-guard` —— 请求含 `defer_loading` 工具声明时跳过注入；
  - `thinking-off` / `purpose-skip` —— 非思考模式与内部辅助请求跳过注入。
- `chatbot_search`：联网搜索，返回带站点、发布时间、权威度的**结构化来源**，便于正文引用。
- `chatbot_image_search`：图片搜索（按图片找相似图片与出处）。
- `chatbot_ocr`：PDF / Word / PPT / 图片文字识别，按页返回；支持纯文本与逐页版面两种模式。
- `chatbot_upload_document`：把本地文档上传到 DeepSeek Files API，拿回 `file_id`；
  支持 `text_recognition` / `rich_layout_recognition` / `user_data` 三种用途。
- `chatbot_tts`：语音合成，落盘返回音频路径；支持音色、格式与自定义术语表 `ttsTermMap`。
- `chatbot_asr`：语音转文字。
- `chatbot_doctor`：自检凭证通道、当前生效配置与守卫状态。
- **界面集成**：助手消息下方新增「朗读」按钮（client slot
  `conversation.chat.assistant-actions`）；语音输入通过官方 `speechToText` 接缝注册
  `deepseek-asr` 提供方，复用官方麦克风 UI。
- **拒答兜底**：`llm/stream` 拦截服务端拒答，转成可读提示而不是让适配器抛错。

### 修复

- 行内代码在朗读时被整段丢弃 —— 改为在客户端拼装可朗读文本后再送服务端。
- 英文术语（`Markdown` 等）在中英混排时被念错 —— 引入 `ttsTermMap` 术语表；
  短键（≤2 字符 ASCII，如 `AI`、`Go`）改用整词匹配，避免撞进 `OPENAI`、`Golang`。

### 文档

- `docs/verification-2026-11-17.md`：逐项实测记录（含守卫端到端验证）。
- `docs/incident-2026-11-17-safety-check-defer-loading.md`：`defer_loading` 互斥事故。
- `docs/incident-2026-11-17-tool-result-image.md`：`tool_result` 非文本互斥事故。
- `docs/feedback-safety-check-exclusivity.md`：三条服务端约束的反馈报告。
- `docs/feedback-tts-code-switch.md`：TTS 中英混排发音问题的反馈报告。

### 已知不覆盖

见 README「不覆盖的能力及原因」一节：阅读链接、深度思考搜索、用户元信息标记、
协议级 citations / 来源卡，以及文档 `file_id` 的对话引用路径尚未实测。

## [0.1.1] 及更早

内部迭代版本，未公开发布，无独立变更记录。
