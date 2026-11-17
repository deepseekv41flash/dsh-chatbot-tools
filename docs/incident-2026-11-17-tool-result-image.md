# 事故 2：`safety_check` 与「带图片的 tool_result」互斥（2026-11-17）

## 症状

会话 `session-37bb04f4-2c09-48e8-84e9-5f14ac2d0921` 报：

```
messages.94: only text content is supported in `tool_result` blocks with
`deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title` yet
(request_id: a0e61cba-94f6-4592-8bf7-5a58ff1856f0)
```

首次失败在 turn 1 step 48，随后 **每一次**新 turn 的 step 1 就失败 —— 与第一起
`defer_loading` 事故同形：错误发生在历史已被持久化之后，会话被卡死，重试无效。

## 归因证据

| 事实 | 证据 |
|---|---|
| 该会话最后一个工具调用是 `read_image` | 解压 `~/.dsh/sessions/--C-Users-Admin--/session-37bb04f4-.../session.v4.jsonl.zstd`（node `zlib.zstdDecompressSync`），事件序号 351：`CALL read_image {"file_path":"...attachments/v1/objects/e0/e..."}` |
| 失败前一请求我们注入了 `safety_check` | `~/.dsh/logs/chatbot-tools-safety.ndjson` 在 `15:27:05` 及之后连续多条 `decision:"enforce"` |
| 同一 runId 连续 4 次失败 | `~/.dsh/logs/desktop-next-2026-11-17.0.jsonl` 中 4 条 `agent.failed`，turn 1 step 48 后 turn 2/3/4 都卡在 step 1 |
| `deepseek_web_search` 不是 DSH 核心注入的 | `grep -c deepseek_web_search app.asar` = 0（`safety_check` 的 8 次命中全是 SDK 类型定义 `pending_safety_checks`，与本机制无关） |

结论：`read_image` 把图片块放进 `tool_result`，而我们插件同时把 `safety_check`
注入同一请求，触发服务端互斥规则。**这是我们插件引起的**（这是它引入的第三个服务端
未文档化约束，前两个是 `defer_loading` 与非思考模式）。

## 修法

`safetyDecision` 新增第三个守卫，顺序在 `thinking-off` 之后、`defer-loading-guard` 之前：

```js
if (nonTextToolResults(request) > 0) return { inject: false, reason: 'non-text-tool-result' }
```

`nonTextToolResults` 扫 `body.messages[].content[]` 里 `type === 'tool_result'` 的块，
其 `content` 为数组且含非 `text` 成员即计数（`content` 为字符串等价于单个 text 块，
不计数）。命中即跳过注入 —— 与 `defer_loading` 守卫同样的「客户端让路」策略。

同时审计日志新增两个字段，便于下次直接归因：

- `serverFields`：四个互斥顶层字段里哪些**在进入 prepare 前**就已在 body 中
  （`safety_check` 若出现在这里，说明是别人注入的，不是我们加的）；
- `nonTextResults`：请求里非文本 tool_result 的块数（由 `safetyDecision` 顺带返回，
  这样 `lib/index.js` 不必新增 import —— 改 import 名单必须重启）。

## 验证

- 单测：`test/safety-guard.test.mjs` 新增 4 例（图片 tool_result 跳过、纯文本不影响、
  字符串 content 不影响、图片与 defer_loading 同时出现时先命中图片守卫），14 条守卫用例表全绿
  （该文件共打印 21 项 PASS：14 条 `decide()` 用例 + `deferredToolNames` 1 项 + 拒答匹配 6 项）。
- 待重启后复验：让该会话重试，应能继续（请求仍在，只是不再带 `safety_check`）。

## 教训（与事故 1 合并成一条规律）

> `safety_check` 是一个**独占性**字段：它会对整条请求的内容形态施加限制
> （工具集形态、思考模式、tool_result 内容类型）。每发现一条新约束，就必须在
> `safetyDecision` 里加一个守卫，并补一个单测固化 —— 否则这类 400 会以
> 「历史已持久化 → 会话不可恢复」的形式爆炸。

同类字段的风险面还没穷尽：`deepseek_web_search` / `deepseek_read_url` / `title`
若日后由别的插件注入，也会踩同一条规则。
