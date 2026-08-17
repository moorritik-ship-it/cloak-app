import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import VideoChatWebRTC from '../components/VideoChatWebRTC'
import VideoChatSessionLayout from '../components/VideoChatSessionLayout'
import { useVideoChatSocket } from '../hooks/useVideoChatSocket.js'
import { getAccessToken, getUserProfileJson } from '../utils/authStorage'

function computeIsOfferer(match) {
  if (typeof match?.is_offerer === 'boolean') return match.is_offerer
  try {
    const raw = getUserProfileJson()
    const id = raw ? JSON.parse(raw)?.id : null
    return Boolean(id && match?.peer_user_id && String(id) < String(match.peer_user_id))
  } catch {
    return false
  }
}

export default function VideoChatPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const displayName = location.state?.displayName ?? 'Guest'
  const token = typeof window !== 'undefined' ? getAccessToken() : null

  const webrtcRef = useRef(null)
  const endedHandledRef = useRef(false)

  const [micMuted, setMicMuted] = useState(false)
  const [filterId, setFilterId] = useState('none')
  const [webrtcKey, setWebrtcKey] = useState(0)

  const { socket, store, joinQueue, clearMatch, sendMessage, skipMatch, endChat, requestChatHistory } =
    useVideoChatSocket({
      token,
      displayName,
      enabled: Boolean(token && displayName),
    })

  const match = store.match
  const phase = store.phase
  const messages = store.messages
  const chatError = store.chatError

  const isSearching = phase === 'searching' || phase === 'connecting' || !match?.room_id
  const inCall = Boolean(match?.room_id) && phase === 'matched'

  const currentUserId = useMemo(() => {
    try {
      const raw = getUserProfileJson()
      if (!raw) return null
      const j = JSON.parse(raw)
      return typeof j?.id === 'string' ? j.id : null
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    if (inCall && match?.room_id) {
      requestChatHistory(match.room_id)
    }
  }, [inCall, match?.room_id, requestChatHistory])

  useEffect(() => {
    if (phase === 'matched') {
      endedHandledRef.current = false
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'ended' || endedHandledRef.current) return
    endedHandledRef.current = true
    webrtcRef.current?.destroyPeer()
    window.setTimeout(() => navigate('/dashboard'), 1200)
  }, [phase, navigate])

  useEffect(() => {
    document.body.classList.toggle('video-chat-body-lock', phase === 'searching' || phase === 'matched')
    return () => document.body.classList.remove('video-chat-body-lock')
  }, [phase])

  const handleNext = useCallback(() => {
    const roomId = match?.room_id
    webrtcRef.current?.destroyPeer()
    setWebrtcKey((k) => k + 1)
    clearMatch()
    if (roomId) skipMatch(roomId)
    else joinQueue()
  }, [match?.room_id, clearMatch, skipMatch, joinQueue])

  const handleEndChat = useCallback(() => {
    const roomId = match?.room_id
    webrtcRef.current?.destroyPeer()
    setWebrtcKey((k) => k + 1)
    if (roomId) endChat(roomId)
    clearMatch()
    navigate('/dashboard')
  }, [match?.room_id, endChat, clearMatch, navigate])

  const handleSendMessage = useCallback(
    (text) => {
      if (!match?.room_id) return
      sendMessage(match.room_id, text)
    },
    [match?.room_id, sendMessage],
  )

  if (!displayName) {
    return (
      <main className="simple-page">
        <section className="simple-card">
          <p>Missing session name. Use Find Match from the dashboard.</p>
          <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
            Dashboard
          </button>
        </section>
      </main>
    )
  }

  if (!token) {
    return (
      <main className="simple-page">
        <section className="simple-card">
          <p>Not signed in.</p>
          <button type="button" className="cta-button cta-primary" onClick={() => navigate('/login')}>
            Login
          </button>
        </section>
      </main>
    )
  }

  if (phase === 'ended') {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card">
          <h1>Chat ended</h1>
          <p>{store.endedMessage || 'Returning to dashboard…'}</p>
        </section>
      </main>
    )
  }

  if (phase === 'timeout') {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card">
          <h1>No match found</h1>
          <p>Try again from the dashboard.</p>
          <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
            Dashboard
          </button>
        </section>
      </main>
    )
  }

  if (phase === 'error') {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card">
          <h1>Connection error</h1>
          <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
            Dashboard
          </button>
        </section>
      </main>
    )
  }

  if (!socket) {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card">
          <p>Connecting…</p>
        </section>
      </main>
    )
  }

  return (
    <div className="video-chat-page video-chat-page--call-mode">
      <VideoChatSessionLayout
        partnerName={match?.peer_username}
        displayName={displayName}
        sessionEndAtMs={match?.session_end_at_ms ?? null}
        isSearching={isSearching}
        micMuted={micMuted}
        filterId={filterId}
        onMicToggle={() => setMicMuted((m) => !m)}
        onFilterChange={setFilterId}
        onNext={handleNext}
        onEndChat={handleEndChat}
        messages={messages}
        chatError={chatError}
        chatEnabled={inCall}
        currentUserId={currentUserId}
        onSendMessage={handleSendMessage}
      >
        <VideoChatWebRTC
          ref={webrtcRef}
          key={webrtcKey}
          socket={socket}
          roomId={match?.room_id ?? null}
          peerUserId={match?.peer_user_id ?? null}
          isOfferer={match ? computeIsOfferer(match) : false}
          isSearching={isSearching}
          micMuted={micMuted}
          filterId={filterId}
        />
      </VideoChatSessionLayout>
    </div>
  )
}
