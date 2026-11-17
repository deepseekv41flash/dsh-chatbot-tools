# 反馈报告（续）：内容安全工具 `safety_check` 的 3 条隐藏互斥，以及 400 后会话不可恢复

| 项 | 值 |
|---|---|
| 接口 | `POST https://api.deepseek.com/anthropic/v1/messages`（Messages，Anthropic 兼容） |
| 相关字段 | `safety_check` / `deepseek_web_search` / `deepseek_read_url` / `title` |
| 发现时间 | 2026-11-17 |
| 前置反馈 | 同日的 TTS 中英混排发音问题（`docs/feedback-tts-code-switch.md`） |
| 严重度 | 高：一次踩中即**永久作废整个会话**，重试无法恢复 |

## 0. 背景

Messages 文档里 `safety_check`、`deepseek_web_search`、`deepseek_read_url`、`title` 是并列的
服务端扩展工具。实测发现：**这四个字段里只要出现任意一个，服务端就会对整个请求施加若干排他性
校验**，而文档没有写明这些校验的存在。

我们是一个第三方客户端（DeepSeek Harness 插件），接了 `safety_check` 做内容安全。三条约束
全部踩了一遍，每条都是 400 硬失败，因此逐条记录下来。

## 1. 约束一：请求体内不能含 `defer_loading: true` 的工具声明

**场景**：多轮会话进行到中途，客户端新增了一个工具。为了不破坏已缓存的提示前缀，客户端把新增
工具声明为 `defer_loading: true`（Anthropic 官方语义，文档有写）。

**结果**：只要同时注入 `safety_check`，请求即被拒。

**问题**：这一类失败没有可读的错误文本（相比下面两条），定位成本最高。

## 2. 约束二：不能在非思考模式

**场景**：`thinking: {"type": "disabled"}`，或客户端发起的辅助性请求（例如生成会话标题，
本身不该消耗思考预算）。

**结果**：同上，被拒。

## 3. 约束三：历史里的 `tool_result` 只能包含纯文本

**错误信息（原文）**：

```
messages.94: only text content is supported in `tool_result` blocks with
`deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title` yet
(request_id: a0e61cba-94f6-4592-8bf7-5a58ff1856f0)
```

**最小复现**：

1. 开启 `safety_check`，正常多轮对话若干轮；
2. 模型调用一个返回图片的工具（我们的 `read_image`），历史中留下一个 `tool_result`，
   其 `content` 是数组，含 `{"type": "image", ...}` 块；
3. 该轮之后，**每一次**请求都返回上面这个 400，且 `messages.94` 恒定不变。

**为什么这条最严重**：错误指向的是**历史**而不是当前请求。历史一旦持久化就删不掉，
所以客户端「重试」永远失败——会话被永久写死，用户只能新开会话，上下文全丢。
错误信息里的 "yet" 暗示这是未实现而非不支持，但当前行为是硬拒绝且不降级。

## 4. 建议

1. **文档补一节**：明确列出这四个字段会开启哪些排他校验（至少上面三条），以及
   「一个请求里只能有一个服务端扩展字段」这类结构性约束是否存在；
2. **错误信息指向根因**：现在三种情况报错各不相同，但都不说是哪条约束被违反。
   约束一甚至没有明确文本。建议统一为可机器识别的 `error.code` + 具体约束名；
3. **约束三改为降级而非拒绝**：例如该轮自动降级为「不带 `safety_check` 发送」并返回警告，
   或允许 `tool_result` 内文本与图片混排。哪怕只是警告，也远好过一个会话被写死；
4. 如果这些校验是刻意的安全设计，也请在文档里说明原因，好让第三方客户端知道
   **接 `safety_check` 需要自建多少守卫**——我们目前实现的是三条守卫 + 21 项回归检查。

## 5. 我们的处理（仅作说明，无需回复）

三条约束已在客户端侧全部实现为守卫，命中任一条就自动跳过本次 `safety_check` 注入，
保证请求不被拒、会话不被写死；每条都配了单元测试。排序为：
`mode-off` → `purpose-skip` → `thinking-off` → `non-text-tool-result` → `defer-loading-guard`
→ `observe` → `enforce`。

另外验证到：约束一的 `defer_loading` 标记会随历史重写（compaction）或进程重启自动消失，
所以它是可自愈的；约束三则完全不可自愈。

---

附：本报告的完整证据链见
- `docs/incident-2026-11-17-safety-check-defer-loading.md`（约束一、二）
- `docs/incident-2026-11-17-tool-result-image.md`（约束三，含 request_id 与宿主日志）
