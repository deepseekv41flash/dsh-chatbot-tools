/**
 * 客户端半边：在每条最终回答的动作行里加一个「朗读」按钮。
 *
 * 数据流刻意不经过客户端取正文：按钮只把 sessionId + messageId 发给宿主，
 * 宿主从会话日志里取出该条 assistant 消息的文本，再调 DeepSeek TTS 返回音频。
 * 这样客户端不需要了解 Chat 快照结构，也不会把长文本塞进 URL。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatbot-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'chatbot-tts',
          order: 12,
        }, SpeakButton))
      },
    }
  },
})
