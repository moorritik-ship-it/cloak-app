import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'
import VideoChatWebRTC from '../components/VideoChatWebRTC'
import VideoChatSessionLayout from '../components/VideoChatSessionLayout'
import { getAccessToken, getUserProfileJson } from '../utils/authStorage'
import { getApiBase, apiUrl } from '../utils/apiBase'
import { ICE_SERVERS } from '../utils/iceServers'

const SUPPORT_EMAIL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_CLOAK_SUPPORT_EMAIL) ||
  'support@cloak.app'

function computeIsOfferer(match) {
  if (typeof match?.is_offerer === 'boolean') return match.is_offerer
  try {
    const raw = getUserProfileJson()
    const u = raw ? JSON.parse(raw)?.id : null
    return Boolean(u && match?.peer_user_id && String(u) < String(match.peer_user_id))
  } catch {
    return false
  }
}

/**
 * Matchmaking + WebRTC: Socket.io queue, then full call UI with chat.
 * Omegle-style Next: same shell, fade, particles, re-queue (no confirmations).
 */
function VideoChatPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const displayName = location.state?.displayName

  const [clientSocket, setClientSocket] = useState(null)
  /** connecting | waiting | matched | timeout | error | ban_blocked */
  const [phase, setPhase] = useState('connecting')
  const [matchPayload, setMatchPayload] = useState(null)
  const [stagedMatch, setStagedMatch] = useState(null)
  const [countdownDigit, setCountdownDigit] = useState(null)
  const [errorMessage, setErrorMessage] = useState(null)

  const [micMuted, setMicMuted] = useState(false)
  const [filterMode, setFilterMode] = useState('none')

  const [remoteFadeOut, setRemoteFadeOut] = useState(false)
  const [webrtcKey, setWebrtcKey] = useState(0)
  const [sessionNotice, setSessionNotice] = useState(null)
  const [skipLockoutUntil, setSkipLockoutUntil] = useState(null)
  const [lockoutClock, setLockoutClock] = useState(0)
  const [freeVideoBan, setFreeVideoBan] = useState(null)
  const [queueUnlockBusy, setQueueUnlockBusy] = useState(false)
  const [banPayError, setBanPayError] = useState(null)

  const transitionToWaitingRef = useRef(null)

  const handleControlsChange = useCallback((next) => {
    if (next.micMuted !== undefined) setMicMuted(next.micMuted)
    if (next.filterMode !== undefined) setFilterMode(next.filterMode)
  }, [])

  const token = typeof window !== 'undefined' ? getAccessToken() : null

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
    transitionToWaitingRef.current = (notice) => {
      setWebrtcKey((k) => k + 1)
      setRemoteFadeOut(true)
      window.setTimeout(() => {
        setMatchPayload(null)
        setStagedMatch(null)
        setCountdownDigit(null)
        setPhase('waiting')
        setRemoteFadeOut(false)
        if (notice) setSessionNotice(notice)
      }, 300)
    }
  }, [])

  useEffect(() => {
    if (!skipLockoutUntil) return
    if (Date.now() >= skipLockoutUntil) {
      setSkipLockoutUntil(null)
      return
    }
    const id = window.setInterval(() => {
      setLockoutClock((c) => c + 1)
      if (Date.now() >= skipLockoutUntil) {
        setSkipLockoutUntil(null)
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [skipLockoutUntil])

  const loadRazorpayScript = useCallback(() => {
    if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
    if (window.Razorpay) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://checkout.razorpay.com/v1/checkout.js'
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('Could not load Razorpay'))
      document.body.appendChild(s)
    })
  }, [])

  const handlePayQueueUnlock = useCallback(async () => {
    const tok = getAccessToken()
    if (!tok || !clientSocket || !displayName) return
    setBanPayError(null)
    setQueueUnlockBusy(true)
    try {
      const res = await fetch(apiUrl('/api/payments/razorpay/queue-unlock-order'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Could not start payment')
      const orderId = data.order_id
      if (String(orderId).startsWith('mock_qu_')) {
        const v = await fetch(apiUrl('/api/payments/razorpay/verify-queue-unlock'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: `pay_mock_${Date.now()}`,
            razorpay_signature: 'mock',
          }),
        })
        const vd = await v.json()
        if (!v.ok) throw new Error(vd.message || 'Verification failed')
        setPhase('waiting')
        setFreeVideoBan(null)
        clientSocket.emit('join_queue', { username: displayName })
        return
      }
      await loadRazorpayScript()
      await new Promise((resolve, reject) => {
        const options = {
          key: data.razorpay_key_id,
          amount: data.amount,
          currency: data.currency || 'INR',
          order_id: orderId,
          name: 'CLOAK',
          description: 'Unlock one Find Match session (₹20)',
          handler: async (response) => {
            try {
              const v = await fetch(apiUrl('/api/payments/razorpay/verify-queue-unlock'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
                body: JSON.stringify({
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }),
              })
              const vd = await v.json()
              if (!v.ok) throw new Error(vd.message || 'Verification failed')
              setPhase('waiting')
              setFreeVideoBan(null)
              clientSocket.emit('join_queue', { username: displayName })
              resolve()
            } catch (e) {
              reject(e instanceof Error ? e : new Error('Payment failed'))
            }
          },
          modal: { ondismiss: () => resolve() },
        }
        const Rzp = window.Razorpay
        if (typeof Rzp !== 'function') {
          reject(new Error('Razorpay failed to load'))
          return
        }
        new Rzp(options).open()
      })
    } catch (e) {
      setBanPayError(e instanceof Error ? e.message : 'Payment failed')
    } finally {
      setQueueUnlockBusy(false)
    }
  }, [clientSocket, displayName, loadRazorpayScript])

  useEffect(() => {
    if (!displayName || !token) {
      return undefined
    }

    const apiBase = getApiBase() || '/'
    console.log('[video-chat] socket.io connecting to', apiBase, { path: '/socket.io' })

    const socket = io(apiBase, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    })

    const onConnect = () => {
      console.log('[video-chat] socket connected', socket.id)
      setClientSocket(socket)
      setMatchPayload(null)
      setStagedMatch(null)
      setCountdownDigit(null)
      setErrorMessage(null)
      setPhase('waiting')
      setSessionNotice(null)
      socket.emit('join_queue', { username: displayName })
    }

    const onJoinedQueue = () => {
      console.log('[video-chat] joined_queue')
      setPhase('waiting')
      setFreeVideoBan(null)
    }

    const onMatchFound = (data) => {
      console.log('[video-chat] match_found received', {
        room_id: data?.room_id,
        peer_user_id: data?.peer_user_id,
        peer_username: data?.peer_username,
        is_offerer: data?.is_offerer,
        socketId: socket.id,
      })
      setSessionNotice(null)
      setStagedMatch(data)
      setCountdownDigit(3)
      setPhase('countdown')
    }

    const onQueueTimeout = () => {
      setPhase('timeout')
    }

    const onQueueError = (err) => {
      if (err?.code === 'FREE_VIDEO_BAN') {
        setFreeVideoBan({
          banUntil: err.ban_until,
          requiresPayment: err.requires_payment,
        })
        setPhase('ban_blocked')
        setErrorMessage(null)
        return
      }
      if (err?.code === 'ACCOUNT_BANNED') {
        setFreeVideoBan({
          banUntil: err.ban_until,
          requiresPayment: false,
          moderation: true,
        })
        setPhase('ban_blocked')
        setErrorMessage(null)
        return
      }
      setPhase('error')
      setErrorMessage(err?.message || 'Queue error.')
    }

    const onConnectError = (err) => {
      console.error('[video-chat] socket connect_error', err?.message || err)
      setPhase('error')
      setErrorMessage(err?.message || 'Could not connect to the matchmaking server.')
    }

    socket.on('connect', onConnect)
    socket.on('joined_queue', onJoinedQueue)
    socket.on('match_found', onMatchFound)
    socket.on('queue_timeout', onQueueTimeout)
    socket.on('queue_error', onQueueError)
    socket.on('connect_error', onConnectError)

    const onSkipAccepted = () => {
      transitionToWaitingRef.current?.('Looking for someone…')
    }
    const onPeerMovedOn = () => {
      transitionToWaitingRef.current?.('Looking for someone…')
    }
    const onSkipError = ({ message }) => {
      setSessionNotice(message || 'Could not skip to next match.')
    }
    const onSkipRateLimited = ({ locked_until_ms }) => {
      if (typeof locked_until_ms === 'number') {
        setSkipLockoutUntil(locked_until_ms)
      }
    }

    const onSessionPayerRematch = ({ message }) => {
      transitionToWaitingRef.current?.(message || 'Finding a new match…')
    }

    const onFreeVideoBan = ({ message, ban_until }) => {
      if (message) setSessionNotice(message)
      if (ban_until) setFreeVideoBan({ banUntil: ban_until })
    }

    const onSessionPaymentOutcome = ({ message }) => {
      if (message) setSessionNotice(message)
    }

    const onAccountBanned = (payload) => {
      setSessionNotice(payload?.message || 'Your account has been restricted.')
      setFreeVideoBan({
        banUntil: payload?.ban_until || null,
        requiresPayment: false,
        moderation: true,
      })
      setPhase('ban_blocked')
    }

    const onPartnerLeftChat = ({ message }) => {
      setWebrtcKey((k) => k + 1)
      setMatchPayload(null)
      setStagedMatch(null)
      setCountdownDigit(null)
      setSessionNotice(message || 'Your partner has left the chat')
      setPhase('partner_left')
      window.setTimeout(() => {
        navigate('/dashboard')
      }, 2500)
    }

    socket.on('skip_accepted', onSkipAccepted)
    socket.on('peer_moved_on', onPeerMovedOn)
    socket.on('skip_error', onSkipError)
    socket.on('skip_rate_limited', onSkipRateLimited)
    socket.on('session_payer_rematch', onSessionPayerRematch)
    socket.on('free_video_ban', onFreeVideoBan)
    socket.on('session_payment_outcome', onSessionPaymentOutcome)
    socket.on('account_banned', onAccountBanned)
    socket.on('partner_left_chat', onPartnerLeftChat)

    return () => {
      socket.off('connect', onConnect)
      socket.off('joined_queue', onJoinedQueue)
      socket.off('match_found', onMatchFound)
      socket.off('queue_timeout', onQueueTimeout)
      socket.off('queue_error', onQueueError)
      socket.off('connect_error', onConnectError)
      socket.off('skip_accepted', onSkipAccepted)
      socket.off('peer_moved_on', onPeerMovedOn)
      socket.off('skip_error', onSkipError)
      socket.off('skip_rate_limited', onSkipRateLimited)
      socket.off('session_payer_rematch', onSessionPayerRematch)
      socket.off('free_video_ban', onFreeVideoBan)
      socket.off('session_payment_outcome', onSessionPaymentOutcome)
      socket.off('account_banned', onAccountBanned)
      socket.off('partner_left_chat', onPartnerLeftChat)
      if (socket.connected) {
        socket.emit('leave_queue')
      }
      socket.disconnect()
      setClientSocket(null)
    }
  }, [displayName, token, navigate])

  useEffect(() => {
    if (phase !== 'countdown' || countdownDigit === null) return
    if (countdownDigit === 0) {
      const sm = stagedMatch
      if (sm) {
        console.log('[video-chat] countdown complete — entering matched phase', {
          room_id: sm.room_id,
          peer_user_id: sm.peer_user_id,
        })
        setMatchPayload(sm)
        setPhase('matched')
      }
      setStagedMatch(null)
      setCountdownDigit(null)
      return
    }
    const t = window.setTimeout(() => {
      setCountdownDigit((d) => (d != null ? d - 1 : d))
    }, 700)
    return () => window.clearTimeout(t)
  }, [phase, countdownDigit, stagedMatch])

  useEffect(() => {
    if (phase === 'waiting' || phase === 'matched' || phase === 'countdown' || phase === 'ban_blocked') {
      document.body.classList.add('video-chat-body-lock')
    } else {
      document.body.classList.remove('video-chat-body-lock')
    }
    return () => document.body.classList.remove('video-chat-body-lock')
  }, [phase])

  const requestSkip = useCallback(() => {
    const roomId = (matchPayload ?? stagedMatch)?.room_id
    if (!clientSocket || !roomId) return
    if (skipLockoutUntil != null && Date.now() < skipLockoutUntil) return
    setWebrtcKey((k) => k + 1)
    clientSocket.emit('skip_match', { room_id: roomId })
  }, [clientSocket, matchPayload, stagedMatch, skipLockoutUntil])

  const handleEndChat = useCallback(() => {
    const roomId = (matchPayload ?? stagedMatch)?.room_id
    setWebrtcKey((k) => k + 1)
    if (clientSocket && roomId) {
      clientSocket.emit('end_chat', { room_id: roomId })
    }
    setMatchPayload(null)
    setStagedMatch(null)
    navigate('/dashboard')
  }, [clientSocket, matchPayload, stagedMatch, navigate])

  const lockoutRemainingSec = useMemo(() => {
    void lockoutClock
    if (skipLockoutUntil == null || Date.now() >= skipLockoutUntil) return 0
    return Math.max(0, Math.ceil((skipLockoutUntil - Date.now()) / 1000))
  }, [skipLockoutUntil, lockoutClock])

  if (!displayName) {
    return (
      <main className="simple-page">
        <section className="simple-card video-chat-card">
          <h1>Video Chat</h1>
          <div className="video-chat-error">
            <p>Missing session name. Go back to the dashboard and use Find Match again.</p>
            <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (!token) {
    return (
      <main className="simple-page">
        <section className="simple-card video-chat-card">
          <h1>Video Chat</h1>
          <div className="video-chat-error">
            <p>Not signed in.</p>
            <button type="button" className="cta-button cta-primary" onClick={() => navigate('/login')}>
              Go to login
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (clientSocket && phase === 'ban_blocked' && freeVideoBan) {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card video-chat-card">
          <h1>{freeVideoBan.moderation ? 'Account restricted' : 'Free match restricted'}</h1>
          {freeVideoBan.moderation ? (
            <p>
              Your CLOAK account is restricted
              {freeVideoBan.banUntil ? (
                <>
                  {' until '}
                  <strong>{new Date(freeVideoBan.banUntil).toLocaleString()}</strong>
                </>
              ) : null}
              . Check your email for details. You may appeal within 7 days by emailing{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`}>
                <strong>{SUPPORT_EMAIL}</strong>
              </a>
              .
            </p>
          ) : (
            <p>
              You cannot use Find Match for free
              {freeVideoBan.banUntil ? (
                <>
                  {' until '}
                  <strong>{new Date(freeVideoBan.banUntil).toLocaleString()}</strong>
                </>
              ) : null}
              . Pay ₹20 to start one session, or wait until the restriction ends.
            </p>
          )}
          {banPayError ? (
            <p className="video-chat-error" role="alert">
              {banPayError}
            </p>
          ) : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
            {!freeVideoBan.moderation ? (
              <button
                type="button"
                className="cta-button cta-primary"
                disabled={queueUnlockBusy}
                onClick={handlePayQueueUnlock}
              >
                {queueUnlockBusy ? 'Processing…' : 'Pay ₹20 & join queue'}
              </button>
            ) : null}
            <button type="button" className="cta-button" onClick={() => navigate('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (phase === 'partner_left') {
    return (
      <main className="simple-page video-chat-page">
        <section className="simple-card video-chat-card">
          <h1>Chat ended</h1>
          <p className="video-chat-status" role="status">
            {sessionNotice || 'Your partner has left the chat'}
          </p>
          <p className="video-chat-hint">Returning to dashboard…</p>
        </section>
      </main>
    )
  }

  const inCallShell =
    clientSocket && (phase === 'waiting' || phase === 'matched' || phase === 'countdown')

  const activeMatch = matchPayload ?? stagedMatch

  if (inCallShell) {
    const partnerLabel =
      phase === 'countdown'
        ? stagedMatch?.peer_username || 'Match found!'
        : activeMatch?.peer_username ?? 'Searching…'
    const nextLocked = skipLockoutUntil != null && Date.now() < skipLockoutUntil

    const chatActive = Boolean(activeMatch?.room_id && (phase === 'matched' || phase === 'countdown'))

    return (
      <div className="video-chat-page video-chat-page--call-mode max-w-[100vw] overflow-x-hidden">
        <VideoChatSessionLayout
          roomId={activeMatch?.room_id ?? null}
          chatEnabled={chatActive}
          sessionEndAtMs={activeMatch?.session_end_at_ms ?? null}
          sessionId={activeMatch?.session_id ?? null}
          partnerUserId={activeMatch?.peer_user_id ?? null}
          currentUserId={currentUserId}
          partnerUsername={partnerLabel}
          displayName={displayName}
          socket={clientSocket}
          micMuted={micMuted}
          filterMode={filterMode}
          onControlsChange={handleControlsChange}
          onNext={requestSkip}
          onEndChat={handleEndChat}
          nextDisabled={nextLocked}
          lockoutRemainingSec={nextLocked ? lockoutRemainingSec : 0}
          sessionNotice={sessionNotice}
          isSearching={phase === 'waiting'}
          onFindNewMatch={() => {
            clientSocket.emit('join_queue', { username: displayName })
            transitionToWaitingRef.current?.('Looking for someone…')
          }}
        >
          <VideoChatWebRTC
            key={webrtcKey}
            socket={clientSocket}
            iceConfig={ICE_SERVERS}
            roomId={activeMatch?.room_id ?? null}
            peerUserId={activeMatch?.peer_user_id ?? null}
            isOfferer={activeMatch ? computeIsOfferer(activeMatch) : false}
            micMuted={micMuted}
            localVideoFilter={filterMode}
            remoteFadeOut={remoteFadeOut}
            skipLockoutUntilMs={skipLockoutUntil}
            lockoutRemainingSec={lockoutRemainingSec}
            countdownDigit={phase === 'countdown' ? countdownDigit : null}
            isSearching={phase === 'waiting'}
          />
        </VideoChatSessionLayout>
      </div>
    )
  }

  return (
    <main className="simple-page video-chat-page">
      <section className="simple-card video-chat-card">
        <h1>Video Chat</h1>
        <p className="video-chat-lead">Start an anonymous conversation with a verified student.</p>

        <p className="video-chat-display-name">
          <strong>Session name:</strong> {displayName}
        </p>

        {phase === 'connecting' ? (
          <p className="video-chat-status" role="status">
            Connecting to matchmaking…
          </p>
        ) : null}

        {phase === 'timeout' ? (
          <div className="video-chat-timeout">
            <p>No match found within 60 seconds.</p>
            <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        ) : null}

        {phase === 'error' && errorMessage ? (
          <div className="video-chat-error">
            <p>{errorMessage}</p>
            <button type="button" className="cta-button cta-primary" onClick={() => navigate('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default VideoChatPage
