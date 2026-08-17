import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { io } from 'socket.io-client'
import { getApiBase } from '../utils/apiBase'

/**
 * Socket + match state stored in refs; useSyncExternalStore triggers re-renders.
 * Listeners are attached once when the socket is created (not in useEffect).
 */
export function useVideoChatSocket({ token, displayName, enabled }) {
  const storeRef = useRef({
    match: null,
    messages: [],
    phase: 'connecting',
    chatError: null,
    endedMessage: null,
  })

  const listenersRef = useRef(new Set())

  const subscribe = useCallback((onStoreChange) => {
    listenersRef.current.add(onStoreChange)
    return () => listenersRef.current.delete(onStoreChange)
  }, [])

  const bump = useCallback(() => {
    listenersRef.current.forEach((fn) => fn())
  }, [])

  const getSnapshot = useCallback(() => storeRef.current, [])

  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const socket = useMemo(() => {
    if (!enabled || !token || !displayName) return null

    const apiBase = getApiBase() || '/'
    const s = io(apiBase, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    })

    const st = storeRef.current

    s.on('match_found', (data) => {
      if (!data?.room_id) return
      st.match = data
      st.phase = 'matched'
      st.messages = []
      st.chatError = null
      st.endedMessage = null
      bump()
    })

    s.on('receive_message', (msg) => {
      if (!msg?.id) return
      if (st.messages.some((m) => m.id === msg.id)) return
      st.messages = [...st.messages, msg]
      bump()
    })

    s.on('chat_message_relay', (msg) => {
      if (!msg?.id) return
      if (st.messages.some((m) => m.id === msg.id)) return
      st.messages = [...st.messages, msg]
      bump()
    })

    s.on('chat_history', ({ room_id: rid, messages: list }) => {
      if (!rid || rid !== st.match?.room_id || !Array.isArray(list)) return
      st.messages = list.map((m) => ({
        id: m.id,
        text: m.text,
        sender_username: m.sender_username,
        sender_user_id: m.sender_user_id,
        sent_at: m.sent_at,
      }))
      bump()
    })

    s.on('chat_error', ({ message }) => {
      st.chatError = typeof message === 'string' ? message : 'Could not send message.'
      bump()
      window.setTimeout(() => {
        st.chatError = null
        bump()
      }, 5000)
    })

    s.on('partner_left', (payload) => {
      st.phase = 'ended'
      st.match = null
      st.endedMessage =
        typeof payload?.message === 'string' ? payload.message : 'Your partner has left the chat'
      bump()
    })

    s.on('partner_left_chat', (payload) => {
      st.phase = 'ended'
      st.match = null
      st.endedMessage =
        typeof payload?.message === 'string' ? payload.message : 'Your partner has left the chat'
      bump()
    })

    s.on('joined_queue', () => {
      if (st.match?.room_id) return
      st.phase = 'searching'
      bump()
    })

    s.on('skip_accepted', () => {
      st.match = null
      st.messages = []
      st.phase = 'searching'
      bump()
      s.emit('join_queue', { username: displayName })
    })

    s.on('peer_moved_on', () => {
      st.match = null
      st.messages = []
      st.phase = 'searching'
      bump()
      s.emit('join_queue', { username: displayName })
    })

    s.on('connect', () => {
      const active = st.match?.room_id
      if (active) {
        s.emit('join_match_room', { room_id: active })
        st.phase = 'matched'
        bump()
        return
      }
      if (st.phase !== 'matched') {
        st.phase = 'searching'
        s.emit('join_queue', { username: displayName })
        bump()
      }
    })

    s.on('connect_error', () => {
      if (st.phase !== 'matched') {
        st.phase = 'error'
        bump()
      }
    })

    s.on('queue_timeout', () => {
      st.phase = 'timeout'
      bump()
    })

    return s
  }, [enabled, token, displayName, bump])

  useEffect(() => {
    return () => {
      if (socket?.connected) {
        socket.emit('leave_queue')
      }
      socket?.disconnect()
    }
  }, [socket])

  const joinQueue = useCallback(() => {
    const st = storeRef.current
    st.match = null
    st.messages = []
    st.phase = 'searching'
    st.endedMessage = null
    bump()
    socket?.emit('join_queue', { username: displayName })
  }, [socket, displayName, bump])

  const clearMatch = useCallback(() => {
    const st = storeRef.current
    st.match = null
    st.messages = []
    st.phase = 'searching'
    bump()
  }, [bump])

  const requestChatHistory = useCallback(
    (roomId) => {
      if (!socket || !roomId) return
      socket.emit('chat_history_request', { room_id: roomId })
    },
    [socket],
  )

  const sendMessage = useCallback(
    (roomId, text) => {
      if (!socket || !roomId || !text?.trim()) return
      socket.emit('send_message', { room_id: roomId, text: text.trim() })
    },
    [socket],
  )

  const skipMatch = useCallback(
    (roomId) => {
      if (!socket || !roomId) return
      socket.emit('skip_match', { room_id: roomId })
    },
    [socket],
  )

  const endChat = useCallback(
    (roomId) => {
      if (!socket || !roomId) return
      socket.emit('end_chat', { room_id: roomId })
    },
    [socket],
  )

  return {
    socket,
    store,
    joinQueue,
    clearMatch,
    sendMessage,
    skipMatch,
    endChat,
    requestChatHistory,
  }
}
