# Changelog

本文件记录本插件的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
