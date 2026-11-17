# dsh-chatbot-tools

[![npm version](https://img.shields.io/npm/v/dsh-chatbot-tools.svg)](https://www.npmjs.com/package/dsh-chatbot-tools)
[![license](https://img.shields.io/npm/l/dsh-chatbot-tools.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-chatbot-tools.svg)](package.json)

补齐 **DeepSeek Chatbot（官方 chat-demo + build_a_chatbot 套件）有、DSH 缺**的能力。

中文 | [English](#english)

| 能力 | Chatbot | DSH 原生 | 本插件 |
|---|---|---|---|
| 内容安全 `safety_check` | ✅ 请求级 | ❌ 无 | ✅ 带 3 条守卫的注入（设置页可调） |
| 图片搜索 | ✅ 服务端工具 | ❌ 无（Search API 明确不支持） | ✅ `chatbot_image_search` |
| 结构化来源（站点/时间/权威度） | ✅ `web_search_result` | 部分（纯文本 Sources） | ✅ `chatbot_search` |
| 拒答（refusal）可读提示 | ✅ 前端处理 | ❌ 适配器抛错 | ✅ `llm/stream` 兜底 |
| 文档识别 OCR | ✅ `/v1/tools/ocr` | 部分（靠技能/本地库） | ✅ `chatbot_ocr` |
| 文档上传（Files API） | ✅ 文件输入 | ❌ 无 | ✅ `chatbot_upload_document`（拿 `file_id`） |
| 语音识别 ASR | ✅ `/v1/tools/asr` | ❌ 无内置 | ✅ `chatbot_asr` + 官方语音输入 UI |
| 语音合成 TTS | ✅ `/v1/tools/tts` | ❌ 无内置 | ✅ `chatbot_tts` + 消息朗读按钮 |

## 不覆盖的能力及原因

本插件**不追求 1:1 覆盖 Chatbot**。以下能力有意不做，或认为不该由本插件承担：

| 能力 | 为什么不覆盖 |
|---|---|
| **阅读链接**（`deepseek_read_url`） | DSH 原生 `web_fetch` 已覆盖该能力；再包一层服务端工具属于重复实现。 |
| **深度思考搜索**（`deep_search`：search → open_page → find_in_page） | Chatbot 应用层的组合式编排；DSH 的「搜索工具 + 思考模式」已能达成相近效果，强行复刻收益低。 |
| **用户元信息标记** | Chatbot 应用层特性（把用户画像塞进系统提示）；DSH 有自己的 system context 与 agent preset 机制，重复注入会打架。 |
| **协议级 citations / 来源卡** | **有意不做**。服务端 `citations` / `citations_delta` 流式块需要自定义 LLM adapter 才能完整渲染，成本远高于收益；本插件改为「结构化来源」（站点、发布时间、权威度）随工具结果返回，模型在正文里自行引用。 |
| **会话标题** | DSH 原生已有标题生成，不需要插件介入。 |
| **文档 `file_id` 的对话引用** | `chatbot_upload_document` 已能把文档上传到 Files API 并返回 `file_id`，但**「把 `file_id` 作为 document 块引用进对话」这条链路尚未实测**，因此不计入「已验证」。上传本身可用。 |

## 开发与热重载（不要用注入器）

本机已装 `dsh-dev-hotreload`（`Pxczxn/dsh-dev-hotreload`）：**保存源码即热替换**，无需重启，也不要调用
`dev_inject_plugin` / `dev_reload_package`——这两个工具在本机有过「工具调用永不返回、会话卡住」的记录
（2026-11-04 `dev_reload_package` 卡住一小时；2026-11-17 `dev_inject_plugin` 触发 `defer_loading` 400 事故）。

工作流：

```bash
# 只改文件，然后等约 1 秒
# 保存 → 防抖 400ms → tick profile/cordis.patch.yml → dsh-hmr 重组合 → 新 fiber
```

判据（两层都要看）：

1. `%TEMP%/dsh-dev-hotreload.log` 出现 `change: lib\index.js` 与 `ticked cordis.patch.yml`；
2. `~/.dsh/logs/chatbot-tools-safety.ndjson` 出现新的 `{"event":"applied:<BUILD_TAG>:safety=..."}`。

`BUILD_TAG` 在 `lib/index.js` 顶部，每次改动递增，用来确认跑的是新代码。

> ⚠️ **热重载只对函数体改动有效**。改 `import` / 增删导出 / 改模块级 `const`（包括 `BUILD_TAG` 本身）
> 都会让 `reload_dsh` 回报 `needs full restart`——必须重启 DSH 才生效。

## 安装

```bash
dsh plugin --profile <profile> add dsh-chatbot-tools
```

本地开发用 link：

```bash
dsh plugin --profile desktop add link:C:/Users/Admin/dsh-chatbot-tools
```

**不要**只用运行时注入：匿名 loader entry 没有包身份，不会出现在「插件」页，也不会被
`dsh-dev-hotreload` 按 profile 依赖自动发现。

> 判据：`plugin_manager list_bundles` 里能看到 `dsh-chatbot-tools`
> （`availability:"profile"`、`installed:true`）才算装好。

## 配置

在 profile patch 的 `config` 覆盖（整行替换，不深合并）：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKey` | 空 | 平台 API Key。**TTS/ASR 必需**；Search/OCR 可用账号登录。明文存 patch，建议改用宿主凭据 |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 宿主凭据服务里的 key 名；DSH 设置里存过的 Key 就在这里 |
| `safetyMode` | `enforce` | `off` / `observe`（只记录）/ `enforce`（注入 `safety_check`） |
| `safetyLevel` | `high` | `high` / `low` |
| `safetyGuardDeferLoading` | `true` | **保持开启**：请求带 `defer_loading` 时跳过注入（事故守卫） |
| `safetySkipPurposes` | `['title','session-title']` | 内部请求不注入，省费用 |
| `safetyLog` | `true` | 记 `~/.dsh/logs/chatbot-tools-safety.ndjson`（只记工具形态） |
| `model` / `maxTokens` / `maxUses` | `deepseek-flash` / `1024` / `1` | 辅助调用与图片搜索的服务端工具参数 |
| `serverTool` | `deepseek_web_search` | 图片搜索用的服务端工具名 |
| `maxImageBytes` | `4194304` | 图片大小上限 |
| `searchCount` | `8` | `chatbot_search` 默认条数 |
| `ocrPurpose` / `ocrMaxChars` | `text_recognition` / `8000` | OCR 模式与返回上限 |
| `documentPurpose` | `text_recognition` | 文档上传默认用途（`user_data` 不解析不计费） |
| `ttsVoice` / `ttsFormat` / `ttsOutDir` / `ttsMaxChars` | `stella` / `wav` / 空（`~/.dsh/chatbot-tools/out`）/ `10000` | 朗读参数 |
| `ttsFilterMarkdown` | `true` | 朗读前由服务端去掉 Markdown。**代码块不会被朗读**，这是服务端行为，与本开关无关 |
| `ttsTermMap` | `{}` | 朗读前的中文替换表，JSON 字符串，如 `{"Markdown":"马克当文档"}` |
| `apiBaseURL` / `messagesBaseURL` / `apiVersion` | 官方地址 | 自建网关时改这里 |

**全部可在「设置 → 插件 → dsh-chatbot-tools」里改**：每个字段都标了 `.volatile()`，宿主据此生成表单，
改完立即生效（volatile 写进运行中的引用），不需要重载插件。凭证解析顺序：
`设置里的 apiKey` → `DEEPSEEK_API_KEY` 环境变量 → **宿主凭据服务**（DSH 设置里存过的 Key）→ DeepSeek 账号登录。

## 界面集成（语音）

### 输入：官方语音输入 UI 复用

官方把语音输入拆成三层，本插件只补最底下那层：

| 层 | 包 | 说明 |
|---|---|---|
| 服务 + provider 注册表 | `@deepseek-ai/dsh-experimental-speech-to-text` | 官方可选 bundle 提供 |
| Remote 控制器 | `@deepseek-ai/dsh-experimental-api-speech-to-text` | 客户端调用它 |
| 麦克风 UI | `@deepseek-ai/dsh-experimental-client-ui-voice-input` | 波形、音色/语种选择 |

本插件新增 `lib/speech.js`：把 `/v1/tools/asr` 包成 `SpeechProvider`（id `deepseek-asr`），
注册进 `ctx.speechToText`。官方麦克风 UI 会直接列出并使用它，**不需要自己写录音界面**。

启用方式：profile 的 `dsh.profile.bundles` 需含 `@deepseek-ai/dsh-experimental-voice-input-bundle`，
语音服务条目 `speech-to-text` 的 `defaultProvider` 设为 `deepseek-asr`。**需重启一次**让该 bundle 的行加载。

### 输出：朗读按钮

- 客户端 `client.js` 注册到官方声明的 `conversation.chat.assistant-actions`（每条最终回答的动作行），
  id `chatbot-tts`，显示 🔊。
- 点击只把 `sessionId` + `messageId` 发给宿主 `GET /chatbot-voice/tts`；
  宿主从会话日志取出该条 assistant 消息正文，调 TTS 后直接返回 `audio/wav`，页面播放。
- 好处：客户端不需要理解 Chat 快照结构，长文本也不进 URL。

> 实测：桌面渲染进程经 `dsh-app://app` 传输访问该路由正常（播放时流式返回、不落盘）；
> 外部 `curl` 会 403（非应用 peer 被拒），不能用它验证。每次朗读会写一条
> `tts-ok:chars=..:bytes=..:ms=..` 审计日志到 `~/.dsh/logs/chatbot-tools-safety.ndjson`。

## 工具

- `chatbot_search(query, count?)` — Search API，返回带站点/发布时间/权威度的来源。
- `chatbot_image_search(path, query?)` — 本地图片 → 服务端图片搜索，返回 `image_url` 缩略图与来源页。
- `chatbot_ocr(path, purpose?)` — PDF/Word/PPT/图片 → 按页文字。
- `chatbot_upload_document(path, purpose?)` — 本地文档 → Files API `file_id`（≤32 MiB / 解析类 ≤100 MiB）。
- `chatbot_asr(path)` — 16-bit PCM WAV / Ogg Opus → 文字（≤120s，≤8 MiB）。
- `chatbot_tts(text, voice?, format?)` — 文本 → 语音文件，返回落盘路径。
- `chatbot_doctor(live?)` — 自检：构建标记、当前设置、凭证通道；`live:true` 时双模式验证 `safety_check`。

## 成本

- `chatbot_search`：Search API 按成功请求计费（¥5 / 1000 次，与 DSH 内置 search 同价）。
- `chatbot_image_search`：一次完整模型回合 + 1 次服务端工具调用；`maxUses:1` 即上限。
- `safety_check`：审核 token 计入输出 token（`usage.output_tokens_details.safety_tokens`）。
- OCR：¥1.5 / 1000 页（按成功页数）。
- 文档上传：`user_data` 不解析、不计费；`text_recognition` / `rich_layout_recognition` 按页计费。
- ASR：¥0.39–0.78 / 小时音频（按秒计）。
- TTS：¥1.5–3 / 10,000 字符（汉字算 2 字符）。

## 已验证 / 未验证

见 `docs/verification-2026-11-17.md`。摘要：

- ✅ `safety_check` + 普通工具 200（**仅思考模式**；新会话实测 `decision:"enforce"`）
- ✅ 非思考模式自动跳过（实测 `thinking=disabled` 同组合 400，故守卫先判 `thinkingEnabled`）
- ✅ `defer_loading` 请求自动跳过注入（多条请求实测守卫命中，无 400）
- ✅ 图片 `tool_result` 请求自动跳过注入（**端到端实测**：守卫命中当次请求，下一请求恢复 `enforce`，会话存活）
- ✅ 图片搜索 15 条结果（含 `image_url`）
- ✅ 搜索 3 条结构化来源
- ✅ OCR / TTS / ASR / 文档上传各自实测通过
- ✅ 卸载：工具立即消失、registry 清空、junction 删除（详见验证文档 §7）
- ✅ 插件页可见：bundle 安装后 `list_bundles` 出现且 `installed:true`
- ✅ 单元测试：`npm test` → 21 + 18 项全绿
- ⚠️ refusal（拒答）**只做了单元测试**（6 例通过）：未主动构造违规输入，属策略边界
- ⚠️ 若真实拒答以 HTTP 400 `Content Exists Risk` 返回，中间件不拦截，表现为普通错误
- ⚠️ 文档 `file_id` 的对话引用链路未实测（见「不覆盖」表）

## 服务端约束（都不是文档写明的）

`deepseekLlmApiExtensions.register('safety_check')` 一旦注入，服务端就会对**整个请求**施加排他性校验。
踩中任何一条都返回 400，而且**历史已持久化后无法重试自救**。本插件为每条都实现了守卫：

| # | 约束 | 守卫 |
|---|---|---|
| 1 | 请求体内不能有 `defer_loading: true` 的工具声明 | `defer-loading-guard` |
| 2 | 不能在非思考模式（`thinking: disabled`，含标题生成等辅助请求） | `thinking-off` / `purpose-skip` |
| 3 | 历史里 `tool_result` 只能纯文本（含图片即拒） | `non-text-tool-result` |

守卫优先级：`mode-off` → `purpose-skip` → `thinking-off` → `non-text-tool-result` → `defer-loading-guard` → `observe` → `enforce`。

三条互斥字段 `deepseek_web_search` / `deepseek_read_url` / `safety_check` / `title` 里，**没有一个**是 DSH 核心注入的
（审计字段 `serverFields` 在每次 `enforce` 请求上都是空数组）。所以第三方插件只要用 `safety_check`，
就必须自己承担上面三条的全部守卫义务。完整证据见 `docs/incident-2026-11-17-*.md`。

## 踩坑

1. **热重载后有一步竞态**：重载返回 OK 后，紧接着的一次请求可能报 `unknown tool "chatbot_xxx"`。原因：新 fiber 注册与旧 fiber 释放在同一 tick 竞争。重试一次即恢复；要彻底避免就重启。
2. **绝不要在 `safety_check` 注入期间让会话发生工具集变更**：见 `docs/incident-2026-11-17-safety-check-defer-loading.md`。本插件的守卫已覆盖该场景，但守卫本身被关掉时会重演。
3. `request.body.tools` 才是扩展契约里工具所在位置；`request.tools` 是文档笔误。
4. **patch 行是整体替换 bundle config**，不是逐键合并——加/删配置键时 `cordis.patch.yml` 与 profile patch 要两边一起对。

## 许可

MIT © 2026 deepseekv41flash

---

## English

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that brings **DeepSeek Chatbot**
capabilities missing from DSH.

| Capability | Provided as |
|---|---|
| Content safety (`safety_check`) | Request-level injection, **3 exclusive-constraint guards**, configurable in Settings |
| Web search with structured sources | `chatbot_search` (site, publish date, authority) |
| Image search | `chatbot_image_search` |
| Document OCR | `chatbot_ocr` (per-page text) |
| Document upload (Files API) | `chatbot_upload_document` → `file_id` |
| Speech-to-text | `chatbot_asr` + official voice-input UI |
| Text-to-speech | `chatbot_tts` + per-message 🔊 button |
| Refusal surfacing | `llm/stream` middleware |

### Not covered (by design)

- **Read URL** — DSH already ships `web_fetch`.
- **Deep search** (search → open_page → find_in_page) — Chatbot-app-level orchestration; DSH's search + thinking mode is close enough.
- **User metadata tagging** — app-level feature that would fight DSH's own system context / agent presets.
- **Protocol-level citations / source cards** — deliberately skipped: rendering server `citations_delta` blocks needs a custom LLM adapter, not worth it. Structured sources are returned instead.
- **Session titles** — DSH has native title generation.
- **Referencing an uploaded `file_id` inside a conversation** — upload works; the reference path is not yet verified end-to-end.

### Install

```bash
dsh plugin --profile <profile> add dsh-chatbot-tools
```

TTS/ASR require a platform API key. Credential order: settings `apiKey` → `DEEPSEEK_API_KEY`
env var → DSH credential service → DeepSeek account login.

### The three server-side constraints

Injecting `safety_check` makes the server enforce exclusivity over the **whole request**.
Each violation is a hard 400 that **cannot be recovered by retrying**, because the offending
history is already persisted. Every constraint is guarded here:

1. No `defer_loading: true` tool declarations may be present → `defer-loading-guard`
2. No non-thinking mode (`thinking: disabled`, incl. title-generation requests) → `thinking-off`
3. `tool_result` blocks must be text-only → `non-text-tool-result`

Guard order: `mode-off` → `purpose-skip` → `thinking-off` → `non-text-tool-result` → `defer-loading-guard` → `observe` → `enforce`.

### License

MIT © 2026 deepseekv41flash
