# 事故报告：`safety_check` × `defer_loading` 冲突导致会话 400 卡死

| 项 | 值 |
|---|---|
| 发生时间 | 2026-11-17 19:46:09（Asia/Shanghai），首次失败 19:46:10 |
| 受影响会话 | `session-36125d3f-d479-4013-b6b5-5a984c95a269`（标题「dsh 补全 Chatbot 功能插件规划」） |
| 受影响插件 | `@dsh-external/dsh-chatbot-tools` 0.1.0（M1 内容安全扩展） |
| 错误码 | `INVALID_REQUEST` / HTTP 400 |
| 状态 | 根因已复现；插件侧已止血；**根治守卫已实施并实测通过（2026-11-17 20:17）** |

---

## 摘要

DSH 在 `deepseek-flash` 上按服务端能力声明启用了「对话中工具增量」投影，会给运行期新增的工具打上
`defer_loading: true`；与此同时，本插件的 M1 会给**每一个**官方 DeepSeek 请求注入顶层 `safety_check`。
服务端规定这两者互斥，于是请求被 400 拒绝。**两个条件单独出现都完全无害**，所以问题在单测式验证里看不出来。

---

## 1. 事故现象与时间线

```
tools[265]: `defer_loading` cannot be used together with
`deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title`
(code: INVALID_REQUEST, status: 400)
```

| 时间 | 事件 | 证据位置 |
|---|---|---|
| 19:46:09 | 第二次 `dev_inject_plugin` 成功，运行期工具集 265 → 268（新增 `chatbot_doctor` / `chatbot_image_search` / `chatbot_search`） | 会话 seq 435 / 481 |
| 19:46:09 | DSH 落库 `developer/message`，headerSeq 503，内含 3 个 `tool-addition` | 会话 seq 504 |
| 19:46:10 | turn 2 step 39 首次 400 | 会话 seq 505 / 507 |
| 之后 | turn 3–6 每轮同一错误（request_id 不同）；turn 7 用户手动中止 | 会话 seq 517 / 529 / 541 / 553 / 562 |

**关键**：这条 `developer/message` 是持久化事件，之后每一轮都重放 → 投影出 `defer_loading` → 每次都 400。
所以会话不是"偶发失败"，而是**不可逆地卡死**。

---

## 2. 根因

### 2.1 两个必要条件（缺一不可）

| 条件 | 产生位置 | 作用范围 |
|---|---|---|
| `safety_check` 顶层字段 | `lib/index.js` M1：`child.deepseekLlmApiExtensions.register('safety_check', …)`，`prepare()` 返回 `{ value: { level: 'high' } }` | **所有**官方 DeepSeek 请求 |
| `defer_loading: true` | DSH 内核 `projectToolUpdates`：路由 `toolUpdate` 生效时，对新增工具写延迟声明 | 会话发生运行期工具集变更后的请求 |

路由为什么会有 `toolUpdate`：服务端 `/models` 对 `deepseek-flash` 声明
`api_capabilities.anthropic_messages.tool_update = "addition-only"`，DSH 读取后启用该投影。

### 2.2 服务端规则

`defer_loading` 不得与 4 个服务端内置能力共存：`deepseek_web_search`、`deepseek_read_url`、
`safety_check`、`title`。这 4 个名字**不在 DSH 客户端代码里**（对 273 MB 的 `app.asar` 做二进制检索，
`deepseek_web_search`/`deepseek_read_url` 零命中），是服务端协议级概念，客户端无法绕开其校验。

### 2.3 为什么两个条件单独都无害

- 只有 `safety_check`（无延迟声明）→ 200
- 只有 `defer_loading`（无 `safety_check`）→ 200
- 两者叠加 → 400

### 2.4 第二条约束（2026-11-17 20:19 补测）

`client tools` + `safety_check` 还要求**思考模式**：`thinking: {type: 'disabled'}` 时同样 400，
报错为 `client tools can only be used together with deepseek_web_search / deepseek_read_url /
safety_check / title in thinking mode`。DSH 真实请求带的是 `thinking: "enabled"`，所以默认路径安全；
用户关掉思考时守卫会跳过注入（`thinking-off`）。

这正是事故难以在早期发现的原因：任何"只测一边"的验证都会通过。

---

## 3. 证据：复现矩阵（2026-11-17 实测）

端点 `https://api.deepseek.com/anthropic/v1/messages`，账号通道 `x-dsh-auth-token`，
模型 `deepseek-flash`，`max_tokens: 16`。

| # | 请求特征 | HTTP | 说明 |
|---|---|---|---|
| S1 | `safety_check` + 普通工具 | 200 | 插件 P0-S1 原本要验的就是这一格 |
| **S2** | **`safety_check` + `defer_loading` 工具** | **400** | **事故最小复现，错误文本逐字一致** |
| S3 | 只有 `safety_check`，无工具 | 200 | |
| S4 | 只有 `defer_loading`，无 `safety_check` | 200 | 事故会话止血后的形态 |
| D | 1 普通 + 1 `defer_loading` | 200 | 混合延迟声明本身合法 |
| N | 真实 268 工具 + 3 个 `defer_loading` + `tool_addition` 块 | 200 | 证明「工具集 + 延迟声明」不是问题 |
| C | 全部工具都 `defer_loading` | 400 | 另一条独立规则：`at least one tool must have defer_loading=false` |
| **T1** | **thinking=enabled + safety_check + 普通工具** | **200** | 思考模式下允许共存（2026-11-17 20:19 复测） |
| **T2** | **thinking=disabled + safety_check + 普通工具** | **400** | 另一条独立规则：非思考模式下 client tools 不能与 `safety_check` 等内置能力共存 |

### 复核命令

```bash
# 1) 证明 flash 声明 addition-only
curl -s https://api.deepseek.com/models -H "x-dsh-auth-token: $TOKEN" \
  | grep -o '"tool_update":"[^"]*"'

# 2) S2：safety_check + defer_loading 必 400
#    body = { model:"deepseek-flash", max_tokens:16,
#             safety_check:{level:"high"},
#             tools:[ {普通工具}, {普通工具, defer_loading:true} ],
#             messages:[{role:"user",content:[{type:"text",text:"reply ok"}]}] }

# 3) S4：去掉 safety_check 后同样请求 → 200
```

---

## 4. 为什么没有更早发现

1. **两个特性在协议上各自都是"支持"的**：`safety_check` 是官方文档写明的内容安全字段，`tool_update` 是
   `/models` 主动声明的能力。它们的**交集**才被禁，而这点没有任何一处文档或声明提示。
2. **插件 P0-S1 的验证题目本身不完整**：原设计只问"安全审核能否与 function tools 共存"（S1 格），
   没问"能否与延迟声明共存"。
3. **触发时机造成误归因**：400 恰好发生在插件注入成功的下一毫秒，很容易被归因为"注入动作本身有毒"，
   从而去找工具集的问题，而真正的扳机是一个与工具毫无关系的顶层字段。

---

## 5. 影响面

任何同时满足以下条件的会话都会中招，且**不可逆**：

1. 路由是 `deepseek-account` 的 `deepseek-flash`（或任何声明了 `tool_update` 的模型）；
2. 会话内发生过运行期工具集变更（`dev_inject_plugin` / `dev_uninject_plugin` / `dev_reload_package` /
   `dev_stage_promote`，或任何动态注册、注销工具的插件操作）；
3. 有插件在请求顶层注入了 `safety_check`（当前即 `dsh-chatbot-tools` 且 `safetyEnabled: true`）。

条件 1 与 2 是 DSH 侧正常能力，不会被取消；因此**插件侧必须让条件 3 与条件 2 互斥**。

---

## 6. 处置

### 6.1 已完成（当日止血，已被 §6.2 取代）

- 事故当刻：`DEFAULTS.safetyEnabled` 由 `true` 改为 `false`，并附事故说明注释。
- 重启后生效路径：`~/.dsh/super-injector/registry.json` 记录本插件，重启时注入器按 registry 重放，
  重新执行 `apply()` 时读取新的 `DEFAULTS` → M1 不再注册 `safety_check`。
- **未改动** `cordis.patch.yml` 与 registry 内容（避免装配方式与工具集发生变化）。
- 现状（2026-11-17 20:20 起）：`safetyEnabled` 布尔已由 `safetyMode: 'enforce'` + §6.2 守卫取代，
  内容安全默认重新开启且不再与延迟声明冲突。

### 6.2 已实施：根治守卫（2026-11-17 20:17）

内容安全改成三态（`off` / `observe` / `enforce`），守卫落在 `lib/safety.js` 的纯函数 `safetyDecision()`：

```js
const tools = Array.isArray(request.body?.tools) ? request.body.tools : []
if (tools.some(tool => tool && tool.defer_loading === true)) {
  return { inject: false, reason: 'defer-loading-guard' }
}
```

**实现要点（与本文档早期草案的差异）**：工具在扩展契约里位于 `request.body.tools`
（`DeepSeekLlmApiExtensionRequest.body`），不是 `request.tools`；草案示例是笔误，按契约实现。

`prepareRequestExtensions` 在 `serialize()` 之后运行，拿到的 body 已含投影结果，因此 `defer_loading` 可见——
已由实测日志确认（`toolCount:268`、`deferredCount:3`、`deferredNames` 为三个 chatbot 工具）。

另修正一处：真实标题请求的 `purpose` 是 `session-title`（不是 `title`），已加入 `safetySkipPurposes`。

**实测结论（详见 `verification-2026-11-17.md`）**：

| 场景 | 结果 |
|---|---|
| 本会话（有延迟声明）连续 3 次请求 | 全部 `defer-loading-guard`，无 400 |
| 新会话（无延迟声明） | `decision:"enforce"`，请求 200 |
| 离线用例 8 条（含「守卫关闭 → 注入」） | 全通过 |

条件 3 与条件 2 现在互斥，`safetyMode: 'enforce'` 已可安全默认开启。

### 6.3 旧会话的处置

该会话历史里已存在 seq 504 那条 `developer/message`，止血后（`safety_check` 不再注入）请求形态变为 S4，
应可恢复正常。若重启后仍报错，按以下顺序处理：

| 顺序 | 做法 | 代价 |
|---|---|---|
| 1 | 确认 `safetyEnabled` 确已生效（请求体无 `safety_check`） | 无 |
| 2 | 把该会话切到 `deepseek-v4-pro`（listing 为 `leading-only`，无延迟声明） | 模型能力与额度 |
| 3 | 清空 seq 504 事件的 `content` 为 `[]` | 需手改 zstd 会话文件；**不要删行**（序号不连续会让解码器丢弃该行及其后全部内容） |

---

## 7. 验证与回滚

**验证（2026-11-17 20:2x 重启后实测，全部通过）**

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 只读探针：调用 `deepseekLlmApiExtensions.prepare({body:{}})` 读当前注册字段 | `fields = ["dsh_plugin_packages"]`，**无 `safety_check`** → M1 已关闭，默认值生效 |
| 2 | `dev_reload_package({packageName:"dsh-chatbot-tools"})` | 成功返回（清缓存 1 模块、重建 1 fiber，before/after 均 `active`），**未复现 2026-11-16 的挂死** |
| 3 | `dev_stage_promote` 新增 1 个工具（真实工具集变更） | 会话写入 `developer/message: tool-addition`，随后请求 **200**（269 工具） |
| 4 | `dev_stage_demote` 移除该工具 | 写入 `developer/message: tool-removal`，随后请求 **200** |
| 5 | 全程失败尝试统计 | `assistant/attempt` 记录 **0 条**（该事件仅在失败时写入） |

**关键补充**：第 2 步的 `dev_reload_package` **本身不会改变工具集**（插件工具 schema 未变，DSH 不写 `developer/message`），
所以单靠重载无法验证 `defer_loading` 路径；必须配合一次真实的工具增删（第 3、4 步）才算验完。

**回滚**

- 把 `lib/index.js` 的 `safetyEnabled` 改回 `true` 即可恢复内容安全注入；
  但**必须同时确认不会再发生工具集变更**，否则事故重演。
- 本报告与 `HANDOFF.md` 均为纯文档，删除无副作用。

---

## 8. 未验证项与遗留风险

| # | 项 | 状态 |
|---|---|---|
| 1 | 重启后 `safetyEnabled: false` 是否真的生效（registry 重放路径） | **已验证**（2026-11-17 20:2x：插件加载、三工具在册、会话可发消息） |
| 2 | §6.2 的 `defer_loading` 守卫是否有效 | **已实施并验证**（`safetyMode: enforce`）：本会话 3 次命中守卫无 400；新会话 `decision:"enforce"` 且 200；离线 8 用例通过 |
| 3 | 服务端为何把 `safety_check` 与 `defer_loading` 设为互斥（是否有文档依据） | **未查证**，仅由报错文本反推；官方 `web_tools` 文档未提此约束 |
| 4 | 除 `safety_check` 外，`title` / `deepseek_read_url` 是否会由其他请求路径注入 | **部分排查**：本插件只在图片搜索的辅助调用里用 `deepseek_web_search`，不碰主对话；主对话的 `title` 不由 DSH 注入 |
| 5 | 该事故是否对其它 profile（web / superagent）同样成立 | **未排查**；只要装同一插件且满足 §5 三条件即成立 |
| 6 | 旧事故会话 `session-36125d3f…` 是否已恢复可对话 | **未验证**（止血后形态与 §3 的 S4 一致，预期可恢复）；且该会话仍带延迟声明，安全审核在其中的生效形态为「跳过」 |
