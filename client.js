/**
 * 客户端半边，两件事：
 *   1. 在每条最终回答的动作行里加一个「朗读」按钮；
 *   2. 在 插件 → dsh-chatbot-tools 页面里加一张配置卡片（内容安全 / 拒答提示两个开关）。
 *
 * 为什么第 2 件事必须写在客户端：
 *   DSH **不会**拿插件 `Config` schema 自动生成表单。Plugins 页只渲染 bundle 自己的行，
 *   配置 UI 必须由插件注册进两个 keyed 槽位之一：
 *     - `plugins.bundle.config`，key = 包名           （渲染在 bundle 页，描述与行之间）
 *     - `plugins.row.config`，   key = `<包名>#<行 id>`（给该行一个 Configure 入口，打开行页）
 *   我们的 bundle 只含一行，所以两处都挂，用户在 bundle 页就能直接看到。
 *   schema 的作用是让宿主**校验并热写**这些字段（.volatile()），不是渲染。
 *
 * 读写走 `ctx.remote.settings`：`describe()` 拿各配置条目的现值与 revision，
 * `mutate(ns, [{op:'set',path,value}], revision)` 写回 profile patch。写入对宿主是
 * volatile 的，改完立即生效，不需要重载插件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatbot-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = 'dsh-chatbot-tools'
    /** 配置条目 id 里一定包含这一段（包名去 dsh- 前缀），用来在 describe() 结果里定位自己。 */
    const NS_FRAGMENT = 'chatbot-tools'

    // ── 1. 朗读按钮 ───────────────────────────────────────────────────────────
    function SpeakButton(props) {
      const [state, setState] = React.useState('idle')
      const audioRef = React.useRef(null)
      const stop = () => {
        const audio = audioRef.current
        if (audio) {
          audio.pause()
          audioRef.current = null
        }
        setState('idle')
      }
      const speak = async () => {
        if (state === 'playing') {
          stop()
          return
        }
        setState('loading')
        try {
          const url = `/chatbot-voice/tts?sessionId=${encodeURIComponent(String(props.sessionId ?? ''))}`
            + `&messageId=${encodeURIComponent(String(props.messageId ?? ''))}`
          const response = await fetch(url, { headers: { accept: 'audio/*' } })
          if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `HTTP ${response.status}`)
          const blob = await response.blob()
          const audio = new Audio(URL.createObjectURL(blob))
          audioRef.current = audio
          audio.onended = () => {
            URL.revokeObjectURL(audio.src)
            audioRef.current = null
            setState('idle')
          }
          await audio.play()
          setState('playing')
        } catch (error) {
          setState('idle')
          console.warn('[dsh-chatbot-tools] 朗读失败：', error)
        }
      }
      const label = state === 'loading' ? '…' : state === 'playing' ? '■' : '🔊'
      const title = state === 'playing' ? '停止朗读' : '朗读这条回答（DeepSeek TTS）'
      return h('button', {
        type: 'button',
        onClick: speak,
        disabled: state === 'loading',
        title,
        'aria-label': title,
        style: {
          background: 'transparent',
          border: 'none',
          padding: '0 4px',
          cursor: state === 'loading' ? 'progress' : 'pointer',
          color: 'inherit',
          opacity: 0.75,
          fontSize: '13px',
          lineHeight: 1,
        },
      }, label)
    }

    // ── 2. 配置卡片 ───────────────────────────────────────────────────────────
    const SWITCHES = [
      {
        key: 'safetyEnabled',
        title: '内容安全（safety_check）',
        hint: '开启后服务端会对整条请求做内容审核。注意：这会拒掉一些正当需求'
          + '（网络安全红队、渗透测试、漏洞利用分析等），因此默认关闭。',
      },
      {
        key: 'refusalNotice',
        title: '拒答提示',
        hint: '开启后把服务端的 refusal 抛错换成一句可读提示；关闭则保持 DSH 原始行为。',
      },
    ]

    const messageOf = (error) => (error === null || error === undefined ? 'unknown error' : error.message ?? String(error))

    /** describe() 的返回值可能是数组，也可能被 Remote 包成 { namespaces: [...] }。 */
    const namespacesOf = (value) => {
      if (Array.isArray(value)) return value
      if (value && Array.isArray(value.namespaces)) return value.namespaces
      return []
    }

    function findSelf(value) {
      return namespacesOf(value).find((row) => {
        const ns = row && row.ns
        return typeof ns === 'string' && ns.includes(NS_FRAGMENT)
      })
    }

    function ConfigCard(props) {
      const settings = props.settings
      const [state, setState] = React.useState({ status: 'loading', ns: null, revision: 0, values: {}, note: null })

      const load = React.useCallback(async () => {
        try {
          const response = await settings.describe()
          if (!response.ok) throw new Error(`settings.describe 失败：${messageOf(response.error)}`)
          const view = findSelf(response.value)
          if (view === undefined) {
            throw new Error(`没有找到本插件的配置条目（期望 id 含 "${NS_FRAGMENT}"）`)
          }
          const value = view.value !== null && typeof view.value === 'object' ? view.value : {}
          const values = {}
          for (const item of SWITCHES) values[item.key] = value[item.key] === true
          setState({ status: 'ready', ns: view.ns, revision: view.revision ?? 0, values, note: null })
        } catch (error) {
          setState((previous) => ({ ...previous, status: 'error', note: messageOf(error) }))
        }
      }, [settings])

      React.useEffect(() => {
        load()
      }, [load])

      const toggle = React.useCallback(async (key, next) => {
        setState((previous) => ({ ...previous, status: 'saving', note: '保存中…', values: { ...previous.values, [key]: next } }))
        try {
          const ops = [{ op: 'set', path: [key], value: next }]
          const response = await settings.mutate(state.ns, ops, state.revision)
          if (!response.ok) throw new Error(`settings.mutate 失败：${messageOf(response.error)}`)
          // 成功后 Remote 会带回新的 namespace 视图，不必再 describe 一次。
          const view = response.value !== null && typeof response.value === 'object' && 'ns' in response.value
            ? response.value
            : (findSelf(response.value) ?? null)
          const revision = view !== null && typeof view.revision === 'number' ? view.revision : state.revision
          setState((previous) => ({ ...previous, status: 'ready', revision, note: '已保存（立即生效）' }))
        } catch (error) {
          setState((previous) => ({ ...previous, status: 'error', note: messageOf(error) }))
          load()
        }
      }, [settings, state.ns, state.revision, load])

      if (state.status === 'loading') {
        return h('div', { style: { fontSize: '12px', opacity: 0.7, padding: '4px 0' } }, '读取配置…')
      }
      if (state.status === 'error' && state.ns === null) {
        return h('div', { style: { fontSize: '12px', color: '#e5534b', padding: '4px 0' } }, state.note)
      }

      const busy = state.status === 'saving'
      const rows = SWITCHES.map((item) => h('label', {
        key: item.key,
        style: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 0', cursor: busy ? 'progress' : 'pointer' },
      },
        h('input', {
          type: 'checkbox',
          checked: state.values[item.key] === true,
          disabled: busy,
          onChange: (event) => toggle(item.key, event.target.checked),
          style: { marginTop: '2px' },
        }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, item.title),
          h('span', { style: { fontSize: '12px', opacity: 0.65, lineHeight: 1.45 } }, item.hint),
        ),
      ))

      return h('div', { style: { display: 'flex', flexDirection: 'column', padding: '2px 0' } },
        rows,
        state.note === null
          ? null
          : h('span', {
            style: {
              fontSize: '12px',
              paddingTop: '4px',
              color: state.status === 'error' ? '#e5534b' : 'inherit',
              opacity: state.status === 'error' ? 1 : 0.55,
            },
          }, state.note),
      )
    }

    // ── 注册 ─────────────────────────────────────────────────────────────────
    return {
      // 三个都声明：`remote` 是父服务，`remote.settings` 才是嵌套访问器。
      // 只声明其中一个的话，另一个在 ctx 上可能是 undefined（会被静默跳过）。
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'chatbot-tts',
          order: 12,
        }, SpeakButton))

        const remoteSettings = ctx.remote === undefined || ctx.remote === null ? undefined : ctx.remote.settings
        if (remoteSettings === undefined || remoteSettings === null) {
          console.warn('[dsh-chatbot-tools] 没有 remote.settings，跳过配置卡片注册')
          return
        }

        // 两处都挂：bundle 页（用户就在那里看）与行页（Configure 入口）。
        const targets = [
          { name: 'plugins.bundle.config', key: PACKAGE },
          { name: 'plugins.row.config', key: `${PACKAGE}#${PACKAGE}` },
        ]
        for (const target of targets) {
          try {
            ctx.slots.inject(target.name, () => ctx.slots.register({
              name: target.name,
              key: target.key,
              id: 'chatbot-tools-config',
              order: 40,
              label: () => '内容安全与拒答',
              inject: () => ({ settings: remoteSettings }),
            }, ConfigCard))
          } catch (error) {
            console.warn(`[dsh-chatbot-tools] 配置卡片未能注册到 ${target.name}（key ${target.key}）：`, error)
          }
        }
      },
    }
  },
})
