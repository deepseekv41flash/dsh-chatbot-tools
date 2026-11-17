# dsh-chatbot-tools

[English](README-en.md) · [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-chatbot-tools)](https://www.npmjs.com/package/dsh-chatbot-tools)
[![license](https://img.shields.io/npm/l/dsh-chatbot-tools)](./LICENSE)

> Brings the **DeepSeek Chatbot** capabilities that DSH lacks into
> [DeepSeek Harness](https://github.com/deepseek-ai): content safety (with guards for three
> server-side exclusive constraints), web & image search, OCR, TTS, ASR, document upload.

| Capability | Chatbot | DSH native | This plugin |
|---|---|---|---|
| Content safety (`safety_check`) | ✅ request-level | ❌ none | ✅ injection (**off by default**, toggle in Settings) |
| Image search | ✅ server tool | ❌ none (Search API doesn't support it) | ✅ `chatbot_image_search` |
| Structured sources (site / date / authority) | ✅ `web_search_result` | partial (plain-text Sources) | ✅ `chatbot_search` |
| Refusal surfacing | ✅ handled in the UI | ❌ adapter throws | ✅ `llm/stream` fallback (**off by default**) |
| Document OCR | ✅ `/v1/tools/ocr` | partial (via skills / local libs) | ✅ `chatbot_ocr` |
| Document upload (Files API) | ✅ file input | ❌ none | ✅ `chatbot_upload_document` → `file_id` |
| Speech-to-text | ✅ `/v1/tools/asr` | ❌ none built in | ✅ `chatbot_asr` + official voice-input UI |
| Text-to-speech | ✅ `/v1/tools/tts` | ❌ none built in | ✅ `chatbot_tts` + per-message 🔊 button |

## Not covered, and why

This plugin does **not** aim for 1:1 parity with Chatbot. The following are deliberately
out of scope:

| Capability | Why not |
|---|---|
| **Read URL** (`deepseek_read_url`) | DSH already ships `web_fetch`; wrapping it again as a server tool is duplication. |
| **Deep search** (`deep_search`: search → open_page → find_in_page) | Chatbot-app-level orchestration. DSH's "search tool + thinking mode" already gets close. |
| **User metadata tagging** | An app-level feature (injecting a user profile into the system prompt). DSH has its own system context and agent presets; duplicating it would fight them. |
| **Protocol-level citations / source cards** | **Deliberately skipped.** Rendering the server's streaming `citations` / `citations_delta` blocks requires a custom LLM adapter — far more cost than value. Structured sources (site, publish date, authority) are returned with the tool result instead, and the model cites them in prose. |
| **Session titles** | DSH already generates titles natively. |

> Referencing an uploaded `file_id` used to be listed here as unverified. It is **verified as of 0.3.0** — see "Verified" below.

## Why content safety and the refusal notice are off by default

Because both of them **weaken DSH itself**:

- `safety_check` makes the server moderate the whole request. It rejects legitimate work — network security red-teaming, penetration testing, exploit analysis, malware triage — and a moderation hit ends the turn with `stop_reason: refusal`.
- The refusal notice only rewrites that error into readable text, but it still changes DSH's native behaviour.

A plugin should not make that trade-off on the user's behalf. Both default to **off**, so out of the box
this plugin has zero impact on DSH's capabilities. Turn them on under
Settings → Plugins → dsh-chatbot-tools when you want content safety.

When enabled, the three server-side exclusivity guards still apply, so turning `safety_check` on can
never brick a session.

## Development & hot reload (do not use injectors)

`dsh-dev-hotreload` is installed on this machine: **saving the source hot-swaps it**, no restart
needed. Do not call `dev_inject_plugin` / `dev_reload_package` — both have caused hung tool calls
on this machine (2026-11-04 `dev_reload_package` hung for an hour; 2026-11-17 `dev_inject_plugin`
triggered the `defer_loading` 400 incident).

Criteria (check both):

1. `%TEMP%/dsh-dev-hotreload.log` shows `change: lib\index.js` and `ticked cordis.patch.yml`;
2. `~/.dsh/logs/chatbot-tools-safety.ndjson` gets a new `{"event":"applied:<BUILD_TAG>:safety=..."}`.

`BUILD_TAG` lives at the top of `lib/index.js` and is bumped on every change.

> ⚠️ **Hot reload only works for changes inside function bodies.** Changing an `import`,
> adding/removing an export, or editing a module-level `const` (including `BUILD_TAG` itself)
> makes `reload_dsh` report `needs full restart` — a DSH restart is required.

## Install

```bash
dsh plugin --profile <profile> add dsh-chatbot-tools
```

For local development, link it:

```bash
dsh plugin --profile desktop add link:C:/Users/Admin/dsh-chatbot-tools
```

Do **not** rely on runtime injection alone: an anonymous loader entry has no package identity,
won't show up on the Plugins page, and won't be discovered by `dsh-dev-hotreload`.

> Check: `plugin_manager list_bundles` must show `dsh-chatbot-tools`
> (`availability:"profile"`, `installed:true`).

## Configuration

Override in the profile patch `config` (a patch row **replaces** the bundle config, it does not merge):

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | empty | Platform API key. **Required for TTS/ASR**; Search/OCR can use account login |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | Key name in the host credential service |
| `safetyEnabled` | `false` | **Master switch, off by default.** When off, `safety_check` is never injected and DSH is unrestricted |
| `safetyMode` | `enforce` | Mode used once the master switch is on: `off` / `observe` (log only) / `enforce` |
| `refusalNotice` | `false` | **Off by default.** When off, refusals keep DSH's native behaviour. Note that turning it on turns the refusal into a normal answer that enters the context, whereas the official demo discards the text and does not send the turn back (see `docs/verification-2026-11-17.md` §23) |
| `safetyLevel` | `high` | `high` / `low` |
| `safetyGuardDeferLoading` | `true` | **Keep on**: skip injection when the request has `defer_loading` |
| `safetySkipPurposes` | `['title','session-title']` | Skip internal requests to save cost |
| `safetyLog` | `true` | Write `~/.dsh/logs/chatbot-tools-safety.ndjson` |
| `model` / `maxTokens` / `maxUses` | `deepseek-flash` / `1024` / `1` | Auxiliary calls and image-search server tool |
| `serverTool` | `deepseek_web_search` | Server tool used by image search |
| `maxImageBytes` | `4194304` | Image size limit |
| `searchCount` | `8` | Default result count for `chatbot_search` |
| `ocrPurpose` / `ocrMaxChars` | `text_recognition` / `8000` | OCR mode and output cap |
| `documentPurpose` | `text_recognition` | Default document upload purpose (`user_data` is not parsed and not billed) |
| `ttsVoice` / `ttsFormat` / `ttsOutDir` / `ttsMaxChars` | `stella` / `wav` / empty (`~/.dsh/chatbot-tools/out`) / `10000` | TTS parameters |
| `ttsFilterMarkdown` | `true` | Strip Markdown server-side before speaking. **Code blocks are never spoken** — server behaviour, unrelated to this switch |
| `ttsTermMap` | `{}` | Replacement map applied before speaking, JSON string, e.g. `{"Markdown":"马克当文档"}` |
| `apiBaseURL` / `messagesBaseURL` / `apiVersion` | official | Change for a self-hosted gateway |

Every field is marked `.volatile()`, so the host renders a settings form under
**Settings → Plugins → dsh-chatbot-tools** and changes take effect immediately.
Credential order: settings `apiKey` → `DEEPSEEK_API_KEY` env var → **host credential service** →
DeepSeek account login.

## UI integration (speech)

### Input: reusing the official voice-input UI

The official implementation splits speech input into three layers; this plugin only supplies the bottom one:

| Layer | Package |
|---|---|
| Service + provider registry | `@deepseek-ai/dsh-experimental-speech-to-text` |
| Remote controller | `@deepseek-ai/dsh-experimental-api-speech-to-text` |
| Microphone UI | `@deepseek-ai/dsh-experimental-client-ui-voice-input` |

`lib/speech.js` wraps `/v1/tools/asr` as a `SpeechProvider` (id `deepseek-asr`) and registers it
into `ctx.speechToText`. The official microphone UI lists and uses it — **no custom recording UI needed**.

Requires `@deepseek-ai/dsh-experimental-voice-input-bundle` in `dsh.profile.bundles` and
`defaultProvider: deepseek-asr` on the `speech-to-text` entry. **One restart** is needed for that
bundle's rows to load.

### Output: the speak button

- `client.js` registers a 🔊 button into the official `conversation.chat.assistant-actions` slot.
- A click sends only `sessionId` + `messageId` to the host `GET /chatbot-voice/tts`; the host pulls
  that assistant message from the session log, calls TTS, and streams back `audio/wav`.
- Benefit: the client never needs to understand the chat snapshot, and long text never goes into a URL.

> Measured: the desktop renderer reaches that route over `dsh-app://app` (streamed, never written to
> disk). External `curl` gets 403 (non-app peers are rejected), so it cannot be used to verify.
> Each playback appends a `tts-ok:chars=..:bytes=..:ms=..` line to `~/.dsh/logs/chatbot-tools-safety.ndjson`.

## Tools

- `chatbot_search(query, count?)` — Search API, returns sources with site/date/authority.
- `chatbot_image_search(path, query?)` — local image → server image search, returns `image_url` and source pages.
- `chatbot_ocr(path, purpose?)` — PDF/Word/PPT/image → per-page text.
- `chatbot_upload_document(path, purpose?)` — local document → Files API `file_id` (≤32 MiB / ≤100 MiB for parse modes).
  Parse purposes accept document formats only (pdf/docx/pptx/xlsx…); plain text (txt/md/json/csv…) must use
  `user_data`, and the plugin rejects the mismatch up front.
- `chatbot_asr(path)` — 16-bit PCM WAV / Ogg Opus → text (≤120 s, ≤8 MiB).
- `chatbot_tts(text, voice?, format?)` — text → audio file, returns the path.
- `chatbot_doctor(live?)` — self-check: build tag, current settings, credential channel.

## Cost

- `chatbot_search`: Search API, billed per successful request (¥5 / 1000, same as DSH's built-in search).
- `chatbot_image_search`: one full model turn + one server-tool call; `maxUses:1` caps it.
- `safety_check`: moderation tokens count as output tokens (`usage.output_tokens_details.safety_tokens`).
- OCR: ¥1.5 / 1000 pages (successful pages).
- Document upload: `user_data` is not parsed and not billed; parse modes are billed per page.
- ASR: ¥0.39–0.78 per hour of audio (per second).
- TTS: ¥1.5–3 / 10,000 characters (a CJK character counts as 2).

## Verified / not verified

See `docs/verification-2026-11-17.md`. Summary:

- ✅ `safety_check` + normal tools → 200 (**thinking mode only**; a fresh session logs `decision:"enforce"`)
- ✅ **Master switch off by default**: missing or `false` `safetyEnabled` always yields `mode-off`, even with `safetyMode=enforce`
- ✅ Non-thinking mode skipped automatically (measured: the same combination returns 400, so the guard checks `thinkingEnabled` first)
- ✅ Requests with `defer_loading` skip injection (guard hits measured, no 400)
- ✅ Requests with an image `tool_result` skip injection (**verified end-to-end**: the guard hit for that one request, the next request returned to `enforce`, session stayed alive)
- ✅ Image search: 15 results with `image_url`
- ✅ Search: 3 structured sources
- ✅ OCR / TTS / ASR / document upload each verified live
- ✅ **The `file_id` reference path is verified**: DOCX upload (`text_recognition`) → referenced as
  `{"type":"document","source":{"type":"file","file_id":…}}` in Messages → the model answered with the
  document's unique marker (`BLUE-FALCON-7731`). `anthropic-beta: files-api-2025-04-14` is **required**;
  without it you get 400 `Missing or invalid anthropic-beta header`.
- ✅ **Purpose × format matrix measured**: `txt`/`md`/`json` + `user_data` → 200; `txt` + `text_recognition` → 400
  `the file format is not supported`. Parse purposes accept document formats only; plain text must use
  `user_data`. The plugin now rejects the mismatch locally with actionable advice instead of passing the
  server's vague error through to the model.
- ✅ Uninstall: tools vanish immediately, registry cleared, junction removed (verification doc §7)
- ✅ Shows up on the Plugins page after bundle install (`installed:true`)
- ✅ Unit tests: `npm test` → 29 + 18 + 31 checks green
- ✅ Files API upload failures are classified from the **error text**, not just the status code
  (file-count limit / storage quota / unsupported / image too large / password-protected /
  unparsable); the patterns come from the official demo client's `src/services/api/errors.ts`
- ✅ Both documented refusal shapes are recognised: output-side `stop_reason: refusal` and
  input-side `400 Content Exists Risk` (including the blocked-image explanation). Four negative
  cases guard against false positives (`max_tokens`, network error, an invalid `safety_check`
  field, and rate limiting must all read as *not* a refusal).
- ⚠️ **A real refusal could not be triggered**: five categories (phishing, violent threat, document
  forgery, hate speech, plus a no-`safety_check` control) all returned 200 + `end_turn` +
  `safety_tokens: 0`. So the interception branch is unit-tested only; the pass-through branch is
  verified end-to-end (with the toggle on, every turn goes through this middleware and streams
  normally). Evidence: `docs/verification-2026-11-17.md` §22.

## Server-side constraints (none of them documented)

Once `deepseekLlmApiExtensions.register('safety_check')` injects `safety_check`, the server enforces
exclusivity over the **whole request**. Any violation returns a 400 that **cannot be recovered by
retrying**, because the offending history is already persisted. Every constraint is guarded — and these
guards are only reached when `safetyEnabled: true`:

| # | Constraint | Guard |
|---|---|---|
| 1 | No `defer_loading: true` tool declarations in the request | `defer-loading-guard` |
| 2 | No non-thinking mode (`thinking: disabled`, including title generation) | `thinking-off` / `purpose-skip` |
| 3 | `tool_result` history must be text-only (an image block is enough to fail) | `non-text-tool-result` |

Guard order: `mode-off` → `purpose-skip` → `thinking-off` → `non-text-tool-result` → `defer-loading-guard` → `observe` → `enforce`.

None of the four mutually exclusive fields (`deepseek_web_search` / `deepseek_read_url` /
`safety_check` / `title`) is injected by DSH core — the audit field `serverFields` is an empty array
on every `enforce` request. So any third-party plugin using `safety_check` inherits all three guards
as its own responsibility. Full evidence in `docs/incident-2026-11-17-*.md`.

## Gotchas

1. **One race right after a hot reload**: the first request following a reload may report `unknown tool "chatbot_xxx"` because the new fiber's registration races the old fiber's disposal in the same tick. Retrying once fixes it; a restart avoids it.
2. **Never let the tool set change mid-session while `safety_check` is injected**: see `docs/incident-2026-11-17-safety-check-defer-loading.md`. The guards cover this, but turning them off reproduces it.
3. `request.body.tools` is where tools live in the extension contract; `request.tools` is a documentation typo.
4. **A patch row replaces the bundle config wholesale**, it does not merge key by key — keep `cordis.patch.yml` and the profile patch in sync when adding/removing keys.

## License

MIT © 2026 deepseekv41flash
