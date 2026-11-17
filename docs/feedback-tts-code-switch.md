# 反馈报告：TTS 在中英混排（中文句子里夹英文术语）时发音错误

| 项 | 值 |
|---|---|
| 接口 | `POST https://api.deepseek.com/v1/tools/tts`（WebSocket 同路径同样受影响） |
| 发现时间 | 2026-11-17 |
| 音色 | `stella`（默认女声），`format: wav`，`filter_markdown: false` |
| 影响 | 编程/技术类文本中英混排极常见（如 Markdown、API、prompt、token），朗读时英文词被念错或消失 |
| 严重度 | 中高：内容可听懂，但关键术语失真，影响可用性 |

## 1. 现象

中文句子里夹英文术语时，英文词有三种表现：

1. **整段/短文本被误判语种**：单独朗读 `Markdown` 时，语种被判成韩语，合成音频送 ASR 转写回来是韩文 `핑가바`；
2. **被汉语音系同化**：`我们讨论一下 Markdown。` → ASR 回写 `我们讨论一下Mardeano。`；
3. **中段有中文锚点时正常**：`这个 Markdown 语法很好用。` → 正常。

## 2. 最小复现（5 组，TTS → ASR 回写）

方法：对同一文本调用 `/v1/tools/tts`，把返回的 wav 再送 `/v1/tools/asr`，比较回写文本。

| # | 输入文本 | 音频 | ASR 回写 | 判定 |
|---|---|---|---|---|
| 1 | `Markdown` | 46,124 B (~0.96 s) | `핑가바` | ❌ 误判为韩语 |
| 2 | `我们讨论一下 Markdown。` | 80,684 B (~1.68 s) | `我们讨论一下Mardeano。` | ❌ 被同化 |
| 3 | `我们讨论一下 Markdown 的用法。` | 90,284 B | `我们讨论一下 Markdown 的用法。` | ✅ |
| 4 | `这个 Markdown 语法很好用。` | 94,124 B | `这个 Markdown 语法很好用。` | ✅ |
| 5 | `We use Markdown to format documents.` | 115,244 B | 原样正确 | ✅ |

结论：判定是**按整段文本**做的，不是逐词；英文词处于句尾或缺少中文锚点时最容易出错。

## 3. 期望与实际

- 期望：中文句中夹带的英文术语按英文发音（或至少可预期地读成中文音译），不出现韩语/失真读音；
- 实际：语种判定与 G2P 在 code-switch 场景不稳定，且没有参数可以干预。

## 4. 建议的改进（任一即可）

1. **加一个 `language` 参数**（如 `zh` / `en` / `auto`），让调用方锁定主语言；
2. **加逐词/逐段的语言标注能力**（如 SSML 的 `<lang>`，或 `segments: [{text, lang}]`）；
3. **加自定义读音/术语表**（如 `pronunciations: {"Markdown": "马克当"}`），或在 text 中支持拼音/音标标注；
4. 退一步：在文档里明确「避免让英文词落在句尾、可加中文锚点」这一限制，并说明不支持 prompt。

## 5. 当前客户端侧的规避（供参考）

调用方只能在朗读前改写文本：把易错英文术语替换成读音稳定的说法（如 `Markdown → 马克当`）。
这既增加维护成本，也无法覆盖未登记的术语——这正是希望能由服务端参数解决的原因。

## 6. 附件

音频样本（本机路径，发送时请替换为实际附件）：

```
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923335105.wav    # 用例 2
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923354795.wav    # 用例 1（Markdown 单词）
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923355920.wav    # 用例 4
```

---

## English summary

**Issue**: `/v1/tools/tts` mispronounces English terms embedded in Chinese text (a very common
pattern in coding/technical content).

**Evidence** (TTS → ASR round-trip, voice `stella`, `filter_markdown: false`, 2026-11-17):

| Input | ASR transcript | Verdict |
|---|---|---|
| `Markdown` (alone) | `핑가바` (Korean) | wrong language detected |
| `我们讨论一下 Markdown。` | `我们讨论一下Mardeano。` | assimilated by Chinese phonology |
| `我们讨论一下 Markdown 的用法。` | unchanged | OK |
| `这个 Markdown 语法很好用。` | unchanged | OK |
| `We use Markdown to format documents.` | unchanged | OK |

**Root cause (inferred)**: language is auto-detected per whole text; there is no `language`
parameter, no per-segment language tagging, no pronunciation lexicon, and no prompt field.

**Requested**: (1) a `language` parameter; or (2) per-segment/per-word language tags (SSML-like);
or (3) a custom pronunciation map; and at minimum a documented workaround.

**Impact**: Chinese technical read-aloud loses or distorts key terms; clients must maintain
term-substitution tables as a workaround.

## 投递记录

| 时间 | 动作 | 结果 |
|---|---|---|
| 2026-11-17 22:38 | 用 `dsh-email`（Outlook / monkey321478965@outlook.com）调用 `email_send` 发往 `api-service@deepseek.com` | ❌ 被拒：「发信未获批准……当前会话处于 Full Access（审批策略 never，不会弹框）」 |
| 2026-11-17 22:38 | 改为 `email_draft` 保存本地草稿，含 3 段音频附件 | ✅ 草稿 `20ef976b-ce96-4802-9d4a-777648a51912` |

**待办**：在「设置 → 邮件 → 草稿」预览并手动发送；或把会话权限切到会弹确认的模式后由 agent 重发。

**踩坑**：Full Access（审批策略 never）下 `dsh-email` 会拒绝需要人工确认的发信，不会弹框；
这是插件与权限策略的交互结果，不是账号或网络问题。草稿路径不触发该限制。

| 时间 | 动作 | 结果 |
|---|---|---|
| 2026-11-17 22:41 | 切到会弹确认的权限模式后重发 `email_send` | ✅ 已送达，messageId `<4c29cbd1-c2fe-1edc-f589-2d41f8c123fa@outlook.com>`，服务器 250 OK |

### 附件

```
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923354795.wav   # 用例 1：Markdown 单念 → 韩文
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923335105.wav   # 用例 2：句尾 → Mardeano
%USERPROFILE%\.dsh\chatbot-tools\out\tts-1794923355920.wav   # 用例 4：中段对照（正常）
```
