import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Flag,
  PhoneOff,
  SkipForward,
  Star,
} from 'lucide-react'
import { CHAT_MAX_CHARS, clampChatInput, countGraphemes } from '../utils/chatText.js'
import { getAccessToken } from '../utils/authStorage.js'
import { apiUrl } from '../utils/apiBase'
import ReportUserModal from './ReportUserModal.jsx'

function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function formatMessageTime(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * Desktop: 70% video + 30% chat. Mobile: full-screen video + swipe-up chat drawer.
 *
 * @param {object} props
 * @param {string | null} [props.roomId]
 * @param {number | null} [props.sessionEndAtMs] — server wall-clock when live session ends (updates on extension)
 * @param {string | null} [props.currentUserId]
 * @param {string} props.partnerUsername
 * @param {string} props.displayName
 * @param {import('react').ReactNode} props.children — video column (VideoChatWebRTC)
 * @param {boolean} props.micMuted
 * @param {boolean} props.cameraOff
 * @param {string} props.filterMode
 * @param {(next: { micMuted: boolean; cameraOff: boolean; filterMode: string }) => void} props.onControlsChange
 * @param {import('socket.io-client').Socket | null} [props.socket]
 * @param {() => void} [props.onNext] — Omegle-style skip (no confirm)
 * @param {boolean} [props.nextDisabled]
 * @param {number} [props.lockoutRemainingSec]
 * @param {string | null} [props.sessionNotice]
 * @param {string | null} [props.sessionId] — DB session id (for rating)
 * @param {string | null} [props.partnerUserId] — matched peer user id (for reporting)
 * @param {() => void} [props.onFindNewMatch] — after post-session (re-queue)
 */
export default function VideoChatSessionLayout({
  roomId = null,
  sessionEndAtMs: sessionEndAtMsProp = null,
  currentUserId = null,
  partnerUserId = null,
  partnerUsername,
  displayName,
  children,
  micMuted,
  cameraOff,
  filterMode,
  onControlsChange,
  socket = null,
  onNext,
  nextDisabled = false,
  lockoutRemainingSec = 0,
  sessionNotice = null,
  sessionId = null,
  onFindNewMatch,
}) {
  const navigate = useNavigate()
  const chatId = useId()
  const messagesEndRef = useRef(null)
  const touchStartY = useRef(null)
  const inputRef = useRef(null)
  const naturalEndEmittedRef = useRef(false)
  const typingStopTimerRef = useRef(null)
  const typingActiveRef = useRef(false)

  const [tick, setTick] = useState(0)
  const [sessionEndOverride, setSessionEndOverride] = useState(null)
  const [extensionOffer, setExtensionOffer] = useState(null)
  const [extensionPayBusy, setExtensionPayBusy] = useState(false)
  const [extensionPaidLocal, setExtensionPaidLocal] = useState(false)
  const [walletRefundNotice, setWalletRefundNotice] = useState(null)

  const [messages, setMessages] = useState([])
  const [inputValue, setInputValue] = useState('')
  const [peerTyping, setPeerTyping] = useState(false)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [postSessionExpiresAt, setPostSessionExpiresAt] = useState(null)
  const [postSessionClosed, setPostSessionClosed] = useState(false)
  const [chatError, setChatError] = useState(null)

  /** Rating phase before post-session (natural end only) */
  const [ratingUi, setRatingUi] = useState(null)
  const [ratingStars, setRatingStars] = useState(0)
  const [ratingFeedback, setRatingFeedback] = useState('')
  const [ratingSubmitted, setRatingSubmitted] = useState(false)
  const [ratingError, setRatingError] = useState(null)

  const [reportOpen, setReportOpen] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)

  const postSessionRemainingMs = useMemoPostSessionRemaining(postSessionExpiresAt)

  const ratingRemainingMs =
    ratingUi && typeof ratingUi.deadlineMs === 'number'
      ? Math.max(0, ratingUi.deadlineMs - Date.now())
      : 0

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [])

  void tick
  const effectiveSessionEndMs = sessionEndOverride ?? sessionEndAtMsProp
  const remainingMs =
    roomId && typeof effectiveSessionEndMs === 'number'
      ? Math.max(0, effectiveSessionEndMs - Date.now())
      : 0
  /** Live video + Next are done; includes rating wait and post-session chat */
  const ratingOrWaitPhase = ratingUi != null && postSessionExpiresAt == null
  const livePhaseEnded =
    postSessionExpiresAt != null ||
    postSessionClosed ||
    ratingOrWaitPhase ||
    (roomId && remainingMs <= 0)

  useEffect(() => {
    if (!roomId || !socket) return
    if (remainingMs > 0) return
    if (postSessionExpiresAt != null || postSessionClosed) return
    if (ratingUi != null) return
    if (naturalEndEmittedRef.current) return
    naturalEndEmittedRef.current = true
    socket.emit('session_end_natural', { room_id: roomId })
  }, [roomId, socket, remainingMs, postSessionExpiresAt, postSessionClosed, ratingUi])

  useEffect(() => {
    if (!roomId) {
      setMessages([])
      setPostSessionExpiresAt(null)
      setPostSessionClosed(false)
      naturalEndEmittedRef.current = false
      setInputValue('')
      setChatError(null)
      setSessionEndOverride(null)
      setExtensionOffer(null)
      setExtensionPaidLocal(false)
      setWalletRefundNotice(null)
      setRatingUi(null)
      setRatingStars(0)
      setRatingFeedback('')
      setRatingSubmitted(false)
      setRatingError(null)
      return
    }
    setMessages([])
    setPostSessionExpiresAt(null)
    setPostSessionClosed(false)
    naturalEndEmittedRef.current = false
    setInputValue('')
    setChatError(null)
    setSessionEndOverride(null)
    setExtensionOffer(null)
    setExtensionPaidLocal(false)
    setWalletRefundNotice(null)
    setRatingUi(null)
    setRatingStars(0)
    setRatingFeedback('')
    setRatingSubmitted(false)
    setRatingError(null)
  }, [roomId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, peerTyping])

  useEffect(() => {
    if (!socket || !roomId) return undefined

    socket.emit('chat_history_request', { room_id: roomId })

    const onHistory = ({ room_id: rid, messages: list }) => {
      if (rid !== roomId || !Array.isArray(list)) return
      setMessages(
        list.map((m) => ({
          id: m.id,
          text: m.text,
          sender_username: m.sender_username,
          sender_user_id: m.sender_user_id,
          sent_at: m.sent_at,
          phase: m.phase,
        })),
      )
    }

    const onRelay = (payload) => {
      if (payload?.room_id !== roomId) return
      setMessages((prev) => {
        if (prev.some((x) => x.id === payload.id)) return prev
        return [
          ...prev,
          {
            id: payload.id,
            text: payload.text,
            sender_username: payload.sender_username,
            sender_user_id: payload.sender_user_id,
            sent_at: payload.sent_at,
            phase: payload.phase,
          },
        ]
      })
    }

    const onPostStarted = ({ room_id: rid, expires_at_ms: exp }) => {
      if (rid !== roomId) return
      setPostSessionExpiresAt(typeof exp === 'number' ? exp : Date.now() + 5 * 60 * 1000)
      setExtensionOffer(null)
      setRatingUi(null)
      setRatingStars(0)
      setRatingFeedback('')
      setRatingSubmitted(false)
      setRatingError(null)
    }

    const onPostClosed = ({ room_id: rid }) => {
      if (rid !== roomId) return
      setPostSessionClosed(true)
      setPostSessionExpiresAt(null)
    }

    const onRatingPhaseStarted = (payload) => {
      if (payload?.room_id !== roomId) return
      const sid = typeof payload?.session_id === 'string' ? payload.session_id : sessionId
      if (!sid) return
      setRatingUi({
        sessionId: sid,
        deadlineMs: typeof payload.deadline_ms === 'number' ? payload.deadline_ms : Date.now() + 5 * 60 * 1000,
        peerUsername: typeof payload.peer_username === 'string' ? payload.peer_username : partnerUsername,
      })
      setRatingStars(0)
      setRatingFeedback('')
      setRatingSubmitted(false)
      setRatingError(null)
    }

    const onRatingSubmitted = () => {
      setRatingSubmitted(true)
      setRatingError(null)
    }

    const onRatingErr = ({ message }) => {
      setRatingError(typeof message === 'string' ? message : 'Could not save rating.')
      window.setTimeout(() => setRatingError(null), 6000)
    }

    const onChatErr = ({ message }) => {
      setChatError(typeof message === 'string' ? message : 'Could not send message.')
      window.setTimeout(() => setChatError(null), 5000)
    }

    const onTyping = () => setPeerTyping(true)
    const onTypingStop = () => setPeerTyping(false)

    const onExtensionOffer = (payload) => {
      if (payload?.room_id !== roomId) return
      setExtensionPaidLocal(false)
      setExtensionOffer({
        extension_deadline_ms: payload.extension_deadline_ms,
        payment_window_ms: payload.payment_window_ms ?? 60000,
        modal_message:
          typeof payload.modal_message === 'string'
            ? payload.modal_message
            : 'Pay ₹20 to extend this chat — you have 1 minute to decide',
        razorpay_key_id: payload.razorpay_key_id,
        razorpay_order_id: payload.razorpay_order_id,
        amount: payload.amount,
        currency: payload.currency || 'INR',
        payment_available: Boolean(payload.payment_available),
      })
    }

    const onSessionExtended = ({ room_id: rid, session_end_at_ms: endMs }) => {
      if (rid !== roomId) return
      if (typeof endMs === 'number') setSessionEndOverride(endMs)
      setExtensionOffer(null)
      setExtensionPaidLocal(false)
    }

    const onWalletRefund = ({ room_id: rid, user_id: uid, amount_inr: amt }) => {
      if (rid !== roomId) return
      if (currentUserId && uid === currentUserId) {
        setWalletRefundNotice(`₹${amt ?? 20} was added to your CLOAK Wallet (refund).`)
        window.setTimeout(() => setWalletRefundNotice(null), 12000)
      }
    }

    socket.on('chat_history', onHistory)
    socket.on('chat_message_relay', onRelay)
    socket.on('post_session_started', onPostStarted)
    socket.on('post_session_closed', onPostClosed)
    socket.on('rating_phase_started', onRatingPhaseStarted)
    socket.on('rating_submitted', onRatingSubmitted)
    socket.on('rating_error', onRatingErr)
    socket.on('chat_error', onChatErr)
    socket.on('chat_typing_relay', onTyping)
    socket.on('chat_typing_stop_relay', onTypingStop)
    socket.on('session_extension_offer', onExtensionOffer)
    socket.on('session_extended', onSessionExtended)
    socket.on('extension_wallet_refund', onWalletRefund)

    return () => {
      socket.off('chat_history', onHistory)
      socket.off('chat_message_relay', onRelay)
      socket.off('post_session_started', onPostStarted)
      socket.off('post_session_closed', onPostClosed)
      socket.off('rating_phase_started', onRatingPhaseStarted)
      socket.off('rating_submitted', onRatingSubmitted)
      socket.off('rating_error', onRatingErr)
      socket.off('chat_error', onChatErr)
      socket.off('chat_typing_relay', onTyping)
      socket.off('chat_typing_stop_relay', onTypingStop)
      socket.off('session_extension_offer', onExtensionOffer)
      socket.off('session_extended', onSessionExtended)
      socket.off('extension_wallet_refund', onWalletRefund)
    }
  }, [socket, roomId, navigate, currentUserId, partnerUsername, sessionId])

  const emitTypingBurst = useCallback(() => {
    if (!socket || !roomId) return
    if (!typingActiveRef.current) {
      typingActiveRef.current = true
      socket.emit('chat_typing', { room_id: roomId })
    }
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current)
    }
    typingStopTimerRef.current = setTimeout(() => {
      typingActiveRef.current = false
      socket.emit('chat_typing_stop', { room_id: roomId })
      typingStopTimerRef.current = null
    }, 2800)
  }, [socket, roomId])

  const postSessionMsgCount = messages.filter(
    (m) => m.phase === 'post_session' && m.sender_user_id === currentUserId,
  ).length
  const postSessionFull = postSessionExpiresAt != null && postSessionMsgCount >= 2
  const inputLocked = !roomId || !socket || postSessionClosed || postSessionFull

  const sendMessage = useCallback(() => {
    if (!socket || !roomId || inputLocked) return
    const text = inputValue.trim()
    const g = countGraphemes(text)
    if (g < 1 || g > CHAT_MAX_CHARS) return
    const phase = postSessionExpiresAt ? 'post_session' : 'live'
    socket.emit('chat_message', { room_id: roomId, text, phase })
    setInputValue('')
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current)
      typingStopTimerRef.current = null
    }
    typingActiveRef.current = false
    socket.emit('chat_typing_stop', { room_id: roomId })
  }, [socket, roomId, inputValue, inputLocked, postSessionExpiresAt])

  const handleSubmitRating = useCallback(() => {
    if (!socket || !roomId || !ratingUi?.sessionId) return
    if (ratingStars < 1 || ratingStars > 5) {
      setRatingError('Choose 1–5 stars.')
      return
    }
    setRatingError(null)
    socket.emit('session_submit_rating', {
      room_id: roomId,
      session_id: ratingUi.sessionId,
      stars: ratingStars,
      feedback: ratingFeedback,
    })
  }, [socket, roomId, ratingUi, ratingStars, ratingFeedback])

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

  const handlePayExtension = useCallback(async () => {
    if (!extensionOffer || !roomId || extensionPayBusy) return
    const token = getAccessToken()
    if (!token) {
      setChatError('Sign in again to pay.')
      return
    }
    setExtensionPayBusy(true)
    try {
      const isMockOrder = String(extensionOffer.razorpay_order_id || '').startsWith('mock_')
      if (isMockOrder) {
        const res = await fetch(apiUrl('/api/payments/razorpay/verify-extension'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            room_id: roomId,
            razorpay_order_id: extensionOffer.razorpay_order_id,
            razorpay_payment_id: `pay_mock_${Date.now()}`,
            razorpay_signature: 'mock',
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.message || 'Payment failed')
        setExtensionPaidLocal(true)
        return
      }

      if (!extensionOffer.payment_available || !extensionOffer.razorpay_key_id) {
        throw new Error('Payments are not available. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET on the server or enable EXTENSION_PAYMENT_MOCK=true.')
      }

      await loadRazorpayScript()
      await new Promise((resolve, reject) => {
        const options = {
          key: extensionOffer.razorpay_key_id,
          amount: extensionOffer.amount,
          currency: extensionOffer.currency,
          order_id: extensionOffer.razorpay_order_id,
          name: 'CLOAK',
          description: 'Extend video session (7 more minutes)',
          handler: async (response) => {
            try {
              const res = await fetch(apiUrl('/api/payments/razorpay/verify-extension'), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  room_id: roomId,
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }),
              })
              const data = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(data.message || 'Verification failed')
              setExtensionPaidLocal(true)
              resolve()
            } catch (e) {
              reject(e instanceof Error ? e : new Error('Verification failed'))
            }
          },
          modal: {
            ondismiss: () => resolve(),
          },
        }
        const Rzp = window.Razorpay
        if (typeof Rzp !== 'function') {
          reject(new Error('Razorpay failed to load'))
          return
        }
        const rzp = new Rzp(options)
        rzp.open()
      })
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Payment failed')
      window.setTimeout(() => setChatError(null), 6000)
    } finally {
      setExtensionPayBusy(false)
    }
  }, [extensionOffer, roomId, extensionPayBusy, loadRazorpayScript])

  const onInputChange = useCallback(
    (e) => {
      const next = clampChatInput(e.target.value)
      setInputValue(next)
      if (countGraphemes(next) > 0) emitTypingBurst()
    },
    [emitTypingBurst],
  )

  const handleNext = useCallback(() => {
    if (nextDisabled || livePhaseEnded) return
    onNext?.()
  }, [nextDisabled, onNext, livePhaseEnded])

  const handleEnd = useCallback(() => {
    if (postSessionClosed) {
      navigate('/dashboard')
      return
    }
    if (postSessionExpiresAt != null) {
      navigate('/dashboard')
      return
    }
    if (ratingUi != null) {
      navigate('/dashboard')
      return
    }
    if (!socket || !roomId) {
      navigate('/dashboard')
      return
    }
    if (!naturalEndEmittedRef.current) {
      naturalEndEmittedRef.current = true
      socket.emit('session_end_natural', { room_id: roomId })
    }
  }, [socket, roomId, navigate, postSessionExpiresAt, postSessionClosed, ratingUi])

  const handleReport = useCallback(() => {
    if (!sessionId || !partnerUserId) {
      setChatError('Reporting is unavailable for this session right now.')
      return
    }
    setChatError(null)
    setReportOpen(true)
  }, [sessionId, partnerUserId])

  const handleBlock = useCallback(async () => {
    if (!sessionId || !partnerUserId) {
      setChatError('Blocking is unavailable for this session right now.')
      return
    }
    if (blockBusy) return
    const ok = window.confirm(
      'Block this user? You will never be matched with each other again. This action can only be undone by contacting support.',
    )
    if (!ok) return
    const tok = getAccessToken()
    if (!tok) {
      setChatError('Not signed in.')
      return
    }
    setBlockBusy(true)
    setChatError(null)
    try {
      const res = await fetch(apiUrl('/api/block'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify({
          blockedUserId: partnerUserId,
          sessionId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message || 'Failed to block user.')
      setSessionEndOverride(Date.now())
      setPostSessionClosed(true)
      window.setTimeout(() => navigate('/dashboard'), 650)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Failed to block user.')
    } finally {
      setBlockBusy(false)
    }
  }, [sessionId, partnerUserId, blockBusy, navigate])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== ' ' && e.key !== 'Escape') return
      const t = e.target
      const tag = t && typeof t === 'object' && 'tagName' in t ? String(t.tagName).toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return
      e.preventDefault()
      handleNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNext])

  const cycleFilter = useCallback(() => {
    const order = ['none', 'warm', 'cool']
    const i = order.indexOf(filterMode)
    const next = order[(i + 1) % order.length]
    onControlsChange({ micMuted, cameraOff, filterMode: next })
  }, [filterMode, micMuted, cameraOff, onControlsChange])

  const toggleMic = useCallback(() => {
    onControlsChange({ micMuted: !micMuted, cameraOff, filterMode })
  }, [micMuted, cameraOff, filterMode, onControlsChange])

  const toggleCam = useCallback(() => {
    onControlsChange({ micMuted, cameraOff: !cameraOff, filterMode })
  }, [micMuted, cameraOff, filterMode, onControlsChange])

  const onDrawerTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY
  }

  const onDrawerTouchEnd = (e) => {
    if (touchStartY.current == null) return
    const y = e.changedTouches[0].clientY
    const delta = y - touchStartY.current
    if (delta < -48) setMobileChatOpen(true)
    if (delta > 48) setMobileChatOpen(false)
    touchStartY.current = null
  }

  const videoSwipeStartY = useRef(null)
  const onVideoAreaTouchStart = (e) => {
    if (e.touches.length !== 1) return
    videoSwipeStartY.current = e.touches[0].clientY
  }
  const onVideoAreaTouchEnd = (e) => {
    if (videoSwipeStartY.current == null) return
    const y = e.changedTouches[0].clientY
    const delta = y - videoSwipeStartY.current
    videoSwipeStartY.current = null
    if (delta < -56) setMobileChatOpen(true)
  }

  const charCount = countGraphemes(inputValue)
  const nextLockedByPhase = livePhaseEnded

  const extensionPaySecondsLeft =
    extensionOffer && typeof extensionOffer.extension_deadline_ms === 'number'
      ? Math.max(0, Math.ceil((extensionOffer.extension_deadline_ms - Date.now()) / 1000))
      : 0

  const ChatPanel = ({ className, id }) => (
    <div className={className} id={id} role="region" aria-label="Text chat">
      {postSessionExpiresAt != null && !postSessionClosed ? (
        <div className="vc-post-session-banner" role="status">
          <div className="vc-post-session-banner-row">
            <span>
              Post-session chat: up to 2 messages each. Closes in {formatCountdown(postSessionRemainingMs)}.
            </span>
            <div className="vc-post-session-actions-inline">
              <button type="button" className="vc-btn-report vc-btn-report--inline" onClick={handleReport}>
                Report
              </button>
              <button
                type="button"
                className="vc-btn-block vc-btn-block--inline"
                onClick={handleBlock}
                disabled={blockBusy}
              >
                Block
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {postSessionClosed ? (
        <div className="vc-post-session-banner vc-post-session-banner--closed" role="status">
          <p className="vc-post-session-closed-msg">Post-session chat has ended.</p>
          <div className="vc-post-session-actions">
            <button
              type="button"
              className="vc-post-session-btn vc-post-session-btn--primary"
              onClick={() => onFindNewMatch?.()}
            >
              Find New Match
            </button>
            <button
              type="button"
              className="vc-post-session-btn vc-post-session-btn--secondary"
              onClick={() => navigate('/dashboard')}
            >
              Exit to Dashboard
            </button>
          </div>
        </div>
      ) : null}
      <div className="vc-chat-messages" role="log" aria-live="polite">
        {sessionNotice ? (
          <div className="vc-chat-bubble vc-chat-bubble--system" role="status">
            {sessionNotice}
          </div>
        ) : null}
        {messages.length === 0 && !sessionNotice ? (
          <p className="vc-chat-empty">No messages yet. Say hello!</p>
        ) : null}
        {messages.length > 0
          ? messages.map((m) => {
              const mine = currentUserId && m.sender_user_id === currentUserId
              return (
                <div
                  key={m.id}
                  className={`vc-chat-bubble ${mine ? 'vc-chat-bubble--me' : 'vc-chat-bubble--peer'}`}
                >
                  <div className="vc-chat-meta">
                    <span className="vc-chat-author">{m.sender_username || 'User'}</span>
                    <span className="vc-chat-time">{formatMessageTime(m.sent_at)}</span>
                    {m.phase === 'post_session' ? (
                      <span className="vc-chat-phase" title="After session">
                        post
                      </span>
                    ) : null}
                  </div>
                  <div className="vc-chat-body">{m.text}</div>
                </div>
              )
            })
          : null}
        {peerTyping ? (
          <div className="vc-typing" aria-live="polite">
            <span className="vc-typing-label">Partner is typing</span>
            <span className="vc-typing-ellipsis" aria-hidden>
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>
      {chatError ? (
        <p className="vc-chat-inline-error" role="alert">
          {chatError}
        </p>
      ) : null}
      <div className="vc-chat-compose">
        <input
          ref={inputRef}
          type="text"
          className="vc-chat-input"
          placeholder={inputLocked ? 'Chat unavailable…' : 'Message…'}
          value={inputValue}
          onChange={onInputChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          }}
          disabled={inputLocked}
          autoComplete="off"
          aria-label="Message input"
          maxLength={CHAT_MAX_CHARS * 4}
        />
        <button
          type="button"
          className="vc-chat-send"
          onClick={sendMessage}
          disabled={inputLocked || charCount < 1}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
      <div className="vc-chat-char-row" aria-live="polite">
        <span className="vc-chat-char-count">
          {charCount}/{CHAT_MAX_CHARS}
        </span>
      </div>
    </div>
  )

  return (
    <div className="vc-session relative flex min-h-0 w-full min-w-0 max-w-[100vw] flex-col overflow-x-hidden bg-[var(--background)] max-md:max-h-[100dvh] max-md:min-h-[100dvh] md:max-h-[calc(100vh-4.5rem)] md:min-h-[calc(100vh-4.5rem)]">
      {walletRefundNotice ? (
        <div className="vc-wallet-refund-strip" role="status">
          {walletRefundNotice}
        </div>
      ) : null}
      <header className="vc-header z-30 flex min-h-[3rem] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-color)] bg-[color-mix(in_srgb,var(--background-secondary)_92%,transparent)] px-3 py-2 text-sm sm:px-4 sm:text-base">
        <div className="vc-header-left">
          <span className="vc-partner-name" title={partnerUsername}>
            {partnerUsername || 'Partner'}
          </span>
          <div className="vc-session-timer-wrap" aria-live="polite" title="Time remaining in live session">
            <span className="vc-session-timer-label">Session ends in</span>
            <span className="vc-session-timer-big">{formatCountdown(remainingMs)}</span>
            {effectiveSessionEndMs != null ? (
              <span className="vc-session-timer-absolute">
                {new Date(effectiveSessionEndMs).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="vc-header-actions max-md:max-w-[min(52vw,13rem)] max-md:overflow-x-auto max-md:pb-0.5 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
          {nextDisabled && lockoutRemainingSec > 0 ? (
            <span className="vc-next-lockout-hint" title="Skip limit">
              Next locked: {Math.floor(lockoutRemainingSec / 60)}:
              {String(lockoutRemainingSec % 60).padStart(2, '0')}
            </span>
          ) : null}
          <button
            type="button"
            className="vc-btn-next vc-btn-next--header max-md:hidden"
            onClick={handleNext}
            aria-label="Next partner"
            disabled={nextDisabled || nextLockedByPhase}
          >
            <SkipForward size={22} strokeWidth={2.5} aria-hidden />
            <span>Next</span>
          </button>
          <button
            type="button"
            className="vc-btn-end min-h-12 shrink-0 px-2 text-xs sm:text-sm"
            onClick={handleEnd}
          >
            <PhoneOff size={18} aria-hidden />
            <span>{postSessionExpiresAt != null || postSessionClosed ? 'Leave' : 'End Chat'}</span>
          </button>
          <button
            type="button"
            className="vc-btn-report min-h-12 shrink-0 px-2 text-xs sm:text-sm"
            onClick={handleReport}
          >
            <Flag size={18} aria-hidden />
            <span>Report</span>
          </button>
          <button
            type="button"
            className="vc-btn-block min-h-12 shrink-0 px-2 text-xs sm:text-sm"
            onClick={handleBlock}
            disabled={blockBusy}
          >
            <span>Block</span>
          </button>
        </div>
      </header>

      <div className="vc-body flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <div
          className="vc-video-col flex min-h-0 min-w-0 flex-col max-md:flex-1"
          onTouchStart={onVideoAreaTouchStart}
          onTouchEnd={onVideoAreaTouchEnd}
        >
          {children}
        </div>
        <aside className="vc-chat-desktop" aria-labelledby={chatId}>
          <h2 id={chatId} className="vc-chat-heading">
            Chat
          </h2>
          <p className="vc-chat-you">
            You: <strong>{displayName}</strong>
          </p>
          <ChatPanel className="vc-chat-panel vc-chat-panel--desktop" />
        </aside>
      </div>

      <footer className="vc-bottom-bar flex shrink-0 items-center justify-center gap-3 px-3 py-2 sm:gap-4 sm:px-4">
        <button
          type="button"
          className={`vc-tool-btn min-h-12 min-w-12 shrink-0 ${micMuted ? 'vc-tool-btn--off' : ''}`}
          onClick={toggleMic}
          aria-pressed={micMuted}
          aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {micMuted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button
          type="button"
          className={`vc-tool-btn min-h-12 min-w-12 shrink-0 ${cameraOff ? 'vc-tool-btn--off' : ''}`}
          onClick={toggleCam}
          aria-pressed={cameraOff}
          aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
        >
          {cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
        </button>
        <button
          type="button"
          className="vc-tool-btn min-h-12 min-w-12 shrink-0"
          onClick={cycleFilter}
          aria-label="Video filter"
          title={`Filter: ${filterMode}`}
        >
          <Sparkles size={22} />
        </button>
      </footer>

      <ReportUserModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        sessionId={sessionId}
        reportedUserId={partnerUserId}
      />

      <button
        type="button"
        className="vc-btn-next vc-btn-next--mobile-float fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-[96] hidden min-h-14 w-[min(20rem,calc(100%-1.5rem))] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center justify-center gap-2 rounded-xl px-8 py-3 text-base font-black shadow-lg max-md:inline-flex md:hidden"
        onClick={handleNext}
        aria-label="Next partner"
        disabled={nextDisabled || nextLockedByPhase}
      >
        <SkipForward size={26} strokeWidth={2.5} aria-hidden />
        <span>Next</span>
      </button>

      <div
        className={`vc-mobile-chat ${mobileChatOpen ? 'vc-mobile-chat--open' : ''}`}
        role="dialog"
        aria-modal={mobileChatOpen}
        aria-label="Chat"
      >
        <button
          type="button"
          className="vc-mobile-chat-handle"
          onClick={() => setMobileChatOpen((o) => !o)}
          onTouchStart={onDrawerTouchStart}
          onTouchEnd={onDrawerTouchEnd}
          aria-expanded={mobileChatOpen}
          aria-label={
            mobileChatOpen ? 'Hide chat' : 'Show chat — swipe up on the video or tap here'
          }
        >
          {mobileChatOpen ? <ChevronDown size={22} /> : <ChevronUp size={22} />}
          <span>Chat</span>
        </button>
        <div className="vc-mobile-chat-sheet">
          <ChatPanel className="vc-chat-panel vc-chat-panel--mobile" />
        </div>
      </div>

      {mobileChatOpen ? (
        <button
          type="button"
          className="vc-mobile-chat-backdrop"
          aria-label="Close chat"
          onClick={() => setMobileChatOpen(false)}
        />
      ) : null}

      {ratingUi && postSessionExpiresAt == null ? (
        <div className="vc-rating-overlay" role="dialog" aria-modal="true" aria-labelledby="vc-rating-title">
          <div className="vc-rating-card">
            <h2 id="vc-rating-title" className="vc-rating-title">
              How was your conversation?
            </h2>
            <p className="vc-rating-peer">with {ratingUi.peerUsername || 'your partner'}</p>
            <div className="vc-rating-stars" role="group" aria-label="Star rating 1 to 5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`vc-star-btn ${ratingStars >= n ? 'vc-star-btn--on' : ''}`}
                  onClick={() => !ratingSubmitted && setRatingStars(n)}
                  disabled={ratingSubmitted}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                >
                  <Star
                    size={36}
                    strokeWidth={1.75}
                    aria-hidden
                    fill={ratingStars >= n ? 'currentColor' : 'none'}
                  />
                </button>
              ))}
            </div>
            <label className="vc-rating-feedback-label">
              <span>Feedback (optional)</span>
              <textarea
                className="vc-rating-textarea"
                rows={3}
                maxLength={2000}
                value={ratingFeedback}
                onChange={(e) => setRatingFeedback(e.target.value.slice(0, 2000))}
                disabled={ratingSubmitted}
              />
            </label>
            <div className="vc-rating-report-row">
              <button type="button" className="vc-btn-report vc-btn-report--rating" onClick={handleReport}>
                Report
              </button>
            </div>
            {ratingError ? (
              <p className="vc-rating-err" role="alert">
                {ratingError}
              </p>
            ) : null}
            {ratingSubmitted ? (
              <p className="vc-rating-wait" role="status">
                Thanks! Waiting for your partner… Post-session chat will open next.
              </p>
            ) : (
              <button
                type="button"
                className="vc-rating-submit"
                onClick={handleSubmitRating}
                disabled={ratingStars < 1}
              >
                Submit
              </button>
            )}
            <p className="vc-rating-deadline">Time left: {formatCountdown(ratingRemainingMs)}</p>
          </div>
        </div>
      ) : null}

      {extensionOffer && !postSessionExpiresAt ? (
        <div className="vc-extension-overlay" role="presentation">
          <div
            className="vc-extension-modal vc-extension-modal--pulse"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vc-extension-title"
          >
            <h2 id="vc-extension-title" className="vc-extension-title">
              {extensionOffer.modal_message} ({extensionPaySecondsLeft}s left)
            </h2>
            <p className="vc-extension-desc">
              If <strong>both</strong> of you pay within 1 minute, your session extends to <strong>14 minutes</strong>{' '}
              with the same person. If <strong>neither</strong> pays, the session ends at 7:00 and both accounts
              cannot use free Find Match for 7 days. If <strong>only one</strong> pays, the payer is rematched for
              free and the other user is restricted from free match for 7 days.
            </p>
            {extensionPaidLocal ? (
              <p className="vc-extension-wait">Payment received. Waiting for partner…</p>
            ) : null}
            <button
              type="button"
              className="vc-extension-pay-btn"
              onClick={handlePayExtension}
              disabled={extensionPayBusy || extensionPaidLocal || extensionPaySecondsLeft <= 0}
            >
              {extensionPaidLocal ? 'Paid' : extensionPayBusy ? 'Processing…' : 'Pay ₹20 with Razorpay'}
            </button>
            {!extensionOffer.payment_available ? (
              <p className="vc-extension-hint">
                Server: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or EXTENSION_PAYMENT_MOCK=true for dev.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function useMemoPostSessionRemaining(expiresAtMs) {
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    if (expiresAtMs == null) return undefined
    const update = () => setNowMs(Date.now())
    // Update shortly after mount/changes without calling setState synchronously in the effect body.
    const t0 = setTimeout(update, 0)
    const id = setInterval(update, 1000)
    return () => {
      clearTimeout(t0)
      clearInterval(id)
    }
  }, [expiresAtMs])
  if (expiresAtMs == null) return 0
  if (!nowMs) return 0
  return Math.max(0, Number(expiresAtMs) - nowMs)
}
