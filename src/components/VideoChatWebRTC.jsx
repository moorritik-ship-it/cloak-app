import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Peer from 'simple-peer'
import MatchingParticles from './MatchingParticles.jsx'
import MatchCountdownOverlay from './MatchCountdownOverlay.jsx'
import { useCloakEngagement } from '../hooks/useCloakEngagement.js'
import { FILTERS, useCanvasVideoFilters } from '../hooks/useCanvasVideoFilters.js'
import { ICE_SERVERS } from '../utils/iceServers.js'

const CONNECT_TIMEOUT_MS = 25_000
const MAX_AUTO_RETRIES = 4
const OFFER_REQUEST_DELAY_MS = 2_500

/** @param {object} iceConfig */
function buildPeerRtcConfig(iceConfig, role) {
  const servers = iceConfig?.iceServers?.length ?? 0
  const turnServers = (iceConfig?.iceServers || []).filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls.join(' ') : String(s.urls || '')
    return urls.includes('turn:') || urls.includes('turns:')
  }).length
  console.log('[video-chat] simple-peer config', { role, iceServers: servers, turnServers, sdpSemantics: iceConfig?.sdpSemantics })
  return {
    sdpSemantics: 'unified-plan',
    ...iceConfig,
  }
}

/** @param {object} signal */
function describeSignal(signal) {
  if (!signal || typeof signal !== 'object') return { kind: 'unknown' }
  if (signal.type === 'offer' || signal.type === 'answer') {
    return { kind: signal.type }
  }
  if (signal.candidate) {
    const c = String(signal.candidate.candidate || signal.candidate)
    const relay = c.includes(' typ relay ')
    const host = c.includes(' typ host ')
    const srflx = c.includes(' typ srflx ')
    return { kind: 'candidate', relay, host, srflx, preview: c.slice(0, 80) }
  }
  return { kind: signal.type || 'signal' }
}

/**
 * @param {object} props
 * @param {import('socket.io-client').Socket} props.socket
 * @param {object} [props.iceConfig] — RTCPeerConnection ICE config (STUN + TURN)
 * @param {string | null} props.roomId
 * @param {string | null} props.peerUserId
 * @param {boolean} props.isOfferer
 * @param {() => void} [props.onPeerDisconnected]
 * @param {boolean} [props.micMuted]
 * @param {boolean} [props.cameraOff]
 * @param {string} [props.localVideoFilter]
 * @param {boolean} [props.remoteFadeOut] — 300ms fade before tearing down peer (Omegle Next)
 * @param {number | null} [props.skipLockoutUntilMs] — wall-clock ms when Next unlocks
 * @param {number} [props.lockoutRemainingSec]
 * @param {number | null} [props.countdownDigit] — 3…1 pre-connect celebration (room not wired yet)
 */
export default function VideoChatWebRTC({
  socket,
  iceConfig = ICE_SERVERS,
  roomId,
  peerUserId,
  isOfferer,
  onPeerDisconnected,
  micMuted = false,
  cameraOff = false,
  localVideoFilter = 'none',
  remoteFadeOut = false,
  skipLockoutUntilMs = null,
  lockoutRemainingSec = 0,
  countdownDigit = null,
}) {
  const localVideoRef = useRef(null)
  useCloakEngagement(socket, roomId, localVideoRef, cameraOff)
  const localCanvasRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const processedStreamRef = useRef(null)
  const answererIceBufferRef = useRef([])
  const offererIceBufferRef = useRef([])
  const answerAppliedRef = useRef(false)
  const connPhaseRef = useRef('connecting')
  const autoRetryCountRef = useRef(0)
  const offerRequestTimerRef = useRef(null)

  const [mediaError, setMediaError] = useState(null)
  const [hasStream, setHasStream] = useState(false)
  const [connPhase, setConnPhase] = useState('connecting')
  const [failureReason, setFailureReason] = useState(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    connPhaseRef.current = connPhase
  }, [connPhase])

  const [selectedFilter, setSelectedFilter] = useState(() => String(localVideoFilter || 'none'))
  const [pitchEnabled, setPitchEnabled] = useState(false)
  const [pitchSemitones, setPitchSemitones] = useState(4)

  useEffect(() => {
    setSelectedFilter(String(localVideoFilter || 'none'))
  }, [localVideoFilter])

  const { previews } = useCanvasVideoFilters({
    videoRef: localVideoRef,
    canvasRef: localCanvasRef,
    enabled: true,
    selectedFilterId: selectedFilter,
    virtualBgUrl: '',
  })

  const selectedLabel = useMemo(
    () => FILTERS.find((f) => f.id === selectedFilter)?.label || 'Filter',
    [selectedFilter],
  )

  const destroyPeer = useCallback(() => {
    answerAppliedRef.current = false
    const p = peerRef.current
    peerRef.current = null
    if (p) {
      try {
        p.destroy()
      } catch {
        // ignore
      }
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
  }, [])

  const stopLocalStream = useCallback(() => {
    const s = localStreamRef.current
    localStreamRef.current = null
    if (s) {
      s.getTracks().forEach((t) => t.stop())
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
  }, [])

  const emitSignal = useCallback(
    (data) => {
      if (!socket?.connected || !roomId) return
      const meta = describeSignal(data)
      if (data.type === 'offer') {
        console.log('[video-chat] ICE/signal sent: offer', { roomId, ...meta })
        socket.emit('webrtc_offer', { room_id: roomId, sdp: data })
      } else if (data.type === 'answer') {
        console.log('[video-chat] ICE/signal sent: answer', { roomId, ...meta })
        socket.emit('webrtc_answer', { room_id: roomId, sdp: data })
      } else {
        console.log('[video-chat] ICE candidate sent', { roomId, ...meta })
        socket.emit('ice_candidate', { room_id: roomId, candidate: data })
      }
    },
    [socket, roomId],
  )

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: true,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        localStreamRef.current = stream
        processedStreamRef.current = null
        setHasStream(true)
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
      } catch (e) {
        if (!cancelled) {
          setMediaError(e?.message || 'Could not access camera or microphone.')
          setConnPhase('failed')
        }
      }
    })()

    return () => {
      cancelled = true
      setHasStream(false)
      stopLocalStream()
    }
  }, [stopLocalStream])

  useEffect(() => {
    const s = localStreamRef.current
    if (!s || !hasStream) return undefined
    if (!pitchEnabled) {
      processedStreamRef.current = null
      return undefined
    }

    let cancelled = false
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const source = ctx.createMediaStreamSource(s)
    const dest = ctx.createMediaStreamDestination()
    const proc = ctx.createScriptProcessor(1024, 1, 1)

    // Keep this client-side; for now a light “distortion” using resampling.
    // Note: This is NOT meant to anonymize/hide identity.
    const rate = clamp(Math.pow(2, pitchSemitones / 12), 0.7, 1.5)
    proc.onaudioprocess = (e) => {
      if (cancelled) return
      const input = e.inputBuffer.getChannelData(0)
      const output = e.outputBuffer.getChannelData(0)
      for (let i = 0; i < output.length; i += 1) {
        const srcIndex = i * rate
        const i0 = Math.floor(srcIndex)
        const i1 = Math.min(input.length - 1, i0 + 1)
        const t = srcIndex - i0
        const a = input[i0] || 0
        const b = input[i1] || 0
        output[i] = a * (1 - t) + b * t
      }
    }

    source.connect(proc)
    proc.connect(dest)

    const out = new MediaStream()
    s.getVideoTracks().forEach((t) => out.addTrack(t))
    dest.stream.getAudioTracks().forEach((t) => out.addTrack(t))
    processedStreamRef.current = out

    return () => {
      cancelled = true
      processedStreamRef.current = null
      try {
        proc.disconnect()
        source.disconnect()
      } catch {
        // ignore
      }
      try {
        ctx.close()
      } catch {
        // ignore
      }
    }
  }, [pitchEnabled, pitchSemitones, hasStream])

  useEffect(() => {
    const s = localStreamRef.current
    if (!s || !hasStream) return
    s.getAudioTracks().forEach((t) => {
      t.enabled = !micMuted
    })
  }, [micMuted, hasStream])

  useEffect(() => {
    const s = localStreamRef.current
    if (!s || !hasStream) return
    s.getVideoTracks().forEach((t) => {
      t.enabled = !cameraOff
    })
  }, [cameraOff, hasStream])

  useEffect(() => {
    const el = localVideoRef.current
    if (!el) return
    // Canvas renders the visible filtered preview; keep source element unfiltered.
    el.style.filter = ''
  }, [localVideoFilter])

  const inCall = Boolean(roomId && peerUserId)

  useEffect(() => {
    if (!socket || !roomId || !peerUserId || mediaError || !hasStream) return
    const stream = processedStreamRef.current || localStreamRef.current
    if (!stream) return

    const peerRole = isOfferer ? 'offerer' : 'answerer'
    const rtcConfig = buildPeerRtcConfig(iceConfig, peerRole)

    console.log('[video-chat] WebRTC starting', { roomId, peerUserId, isOfferer, retryKey })

    answererIceBufferRef.current = []
    offererIceBufferRef.current = []
    answerAppliedRef.current = false

    queueMicrotask(() => {
      setFailureReason(null)
      setConnPhase('connecting')
    })

    const clearOfferRequestTimer = () => {
      if (offerRequestTimerRef.current) {
        clearTimeout(offerRequestTimerRef.current)
        offerRequestTimerRef.current = null
      }
    }

    if (!isOfferer) {
      clearOfferRequestTimer()
      offerRequestTimerRef.current = setTimeout(() => {
        if (!peerRef.current && socket?.connected && roomId) {
          console.log('[video-chat] answerer requesting signal replay (no offer yet)')
          socket.emit('webrtc_request_signals', { room_id: roomId })
        }
      }, OFFER_REQUEST_DELAY_MS)
    }

    const flushAnswererIce = () => {
      const p = peerRef.current
      if (!p) return
      const buf = answererIceBufferRef.current
      while (buf.length) {
        const c = buf.shift()
        try {
          console.log('[video-chat] flushing buffered ICE to answerer peer', describeSignal(c))
          p.signal(c)
        } catch (e) {
          console.warn('[video-chat] flush answerer ICE failed', e)
        }
      }
    }

    const flushOffererIce = () => {
      const p = peerRef.current
      if (!p) return
      const buf = offererIceBufferRef.current
      while (buf.length) {
        const c = buf.shift()
        try {
          console.log('[video-chat] flushing buffered ICE to offerer peer', describeSignal(c))
          p.signal(c)
        } catch (e) {
          console.warn('[video-chat] flush offerer ICE failed', e)
        }
      }
    }

    const applyRemoteSignal = (sdp, label) => {
      const peer = peerRef.current
      if (!peer) {
        console.warn('[video-chat] no peer to apply signal', { label, type: sdp?.type })
        return
      }
      console.log('[video-chat] applying remote signal', { label, ...describeSignal(sdp) })
      peer.signal(sdp)
      if (isOfferer && sdp?.type === 'answer') {
        answerAppliedRef.current = true
        flushOffererIce()
      }
      if (!isOfferer && sdp?.type === 'offer') {
        flushAnswererIce()
      }
    }

    const attachPeerHandlers = (peer) => {
      peer.on('signal', emitSignal)
      peer.on('stream', (remoteStream) => {
        console.log('[video-chat] peer stream event', {
          roomId,
          tracks: remoteStream?.getTracks?.()?.map((t) => t.kind),
        })
        autoRetryCountRef.current = 0
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream
        }
        setConnPhase('live')
      })
      peer.on('connect', () => {
        console.log('[video-chat] peer connect event', { roomId, isOfferer })
        autoRetryCountRef.current = 0
        setConnPhase('live')
      })
      peer.on('error', (err) => {
        console.error('[video-chat] peer error', err?.message || err)
        setFailureReason(err?.message || 'WebRTC error')
        setConnPhase('failed')
      })
      peer.on('close', () => {
        console.warn('[video-chat] peer close event', { roomId })
        if (connPhaseRef.current !== 'live') {
          setConnPhase('failed')
          setFailureReason('Connection closed.')
        }
      })
    }

    const onOfferRelay = ({ sdp }) => {
      if (isOfferer) return
      clearOfferRequestTimer()
      try {
        applyRemoteSignal(sdp, 'offer_relay')
      } catch (e) {
        setFailureReason(e?.message || 'Failed to apply offer')
        setConnPhase('failed')
      }
    }

    const onAnswerRelay = ({ sdp }) => {
      if (!isOfferer) return
      try {
        applyRemoteSignal(sdp, 'answer_relay')
      } catch (e) {
        setFailureReason(e?.message || 'Failed to apply answer')
        setConnPhase('failed')
      }
    }

    const onIceRelay = ({ candidate }) => {
      if (candidate == null) return
      console.log('[video-chat] ICE candidate received', describeSignal(candidate))
      const peer = peerRef.current
      if (!peer) {
        if (isOfferer) {
          offererIceBufferRef.current.push(candidate)
        } else {
          answererIceBufferRef.current.push(candidate)
        }
        return
      }
      if (isOfferer && !answerAppliedRef.current) {
        offererIceBufferRef.current.push(candidate)
        return
      }
      try {
        peer.signal(candidate)
      } catch (e) {
        console.warn('[video-chat] apply ICE candidate failed', e)
      }
    }

    const onRoomError = (err) => {
      console.error('[video-chat] room_error', err?.message || err)
      setFailureReason(err?.message || 'Room error')
      setConnPhase('failed')
    }

    const onPeerDisconnectedEvt = () => {
      destroyPeer()
      setConnPhase('failed')
      setFailureReason('The other participant disconnected.')
      onPeerDisconnected?.()
    }

    socket.on('webrtc_offer_relay', onOfferRelay)
    socket.on('webrtc_answer_relay', onAnswerRelay)
    socket.on('ice_candidate_relay', onIceRelay)
    socket.on('room_error', onRoomError)
    socket.on('webrtc_peer_disconnected', onPeerDisconnectedEvt)

    if (isOfferer) {
      console.log('[video-chat] creating offerer peer', { roomId })
      const peer = new Peer({
        initiator: true,
        trickle: true,
        stream,
        config: rtcConfig,
      })
      peerRef.current = peer
      attachPeerHandlers(peer)
    } else {
      console.log('[video-chat] creating answerer peer', { roomId })
      const peer = new Peer({
        initiator: false,
        trickle: true,
        stream,
        config: rtcConfig,
      })
      peerRef.current = peer
      attachPeerHandlers(peer)
    }

    // Join room and request any signals exchanged before listeners were ready.
    socket.emit('join_match_room', { room_id: roomId })

    const connectTimeout = setTimeout(() => {
      if (connPhaseRef.current !== 'connecting') return
      if (autoRetryCountRef.current >= MAX_AUTO_RETRIES) {
        console.error('[video-chat] WebRTC connect timeout — max retries reached', { roomId })
        setFailureReason('Could not connect to partner. Tap Retry or find a new match.')
        setConnPhase('failed')
        return
      }
      autoRetryCountRef.current += 1
      console.warn('[video-chat] WebRTC connect timeout — auto retry', {
        roomId,
        attempt: autoRetryCountRef.current,
      })
      destroyPeer()
      setRetryKey((k) => k + 1)
    }, CONNECT_TIMEOUT_MS)

    return () => {
      clearTimeout(connectTimeout)
      clearOfferRequestTimer()
      socket.off('webrtc_offer_relay', onOfferRelay)
      socket.off('webrtc_answer_relay', onAnswerRelay)
      socket.off('ice_candidate_relay', onIceRelay)
      socket.off('room_error', onRoomError)
      socket.off('webrtc_peer_disconnected', onPeerDisconnectedEvt)
      destroyPeer()
    }
  }, [
    socket,
    roomId,
    peerUserId,
    mediaError,
    hasStream,
    isOfferer,
    emitSignal,
    destroyPeer,
    onPeerDisconnected,
    retryKey,
    iceConfig,
  ])

  const handleRetry = () => {
    autoRetryCountRef.current = 0
    destroyPeer()
    setFailureReason(null)
    setConnPhase('connecting')
    setRetryKey((k) => k + 1)
  }

  const lockoutActive =
    typeof skipLockoutUntilMs === 'number' && skipLockoutUntilMs > Date.now()

  if (mediaError) {
    return (
      <div className="video-chat-webrtc video-chat-webrtc--error">
        <p>{mediaError}</p>
        <button type="button" className="cta-button cta-primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    )
  }

  return (
    <div className="video-chat-webrtc video-chat-webrtc--fill">
      <div className="video-chat-webrtc-main">
        <video
          ref={remoteVideoRef}
          className={`video-chat-remote ${remoteFadeOut ? 'video-chat-remote--fade-out' : ''}`}
          playsInline
          autoPlay
          aria-label="Remote participant video"
        />
        {!inCall ? (
          <div className="video-chat-search-layer">
            <MatchingParticles />
            <p className="video-chat-search-label">
              {typeof countdownDigit === 'number' && countdownDigit > 0
                ? 'Match found!'
                : 'Looking for someone…'}
            </p>
            {typeof countdownDigit === 'number' && countdownDigit > 0 ? (
              <MatchCountdownOverlay digit={countdownDigit} />
            ) : null}
          </div>
        ) : null}
        {inCall && connPhase === 'connecting' ? (
          <div className="video-chat-webrtc-overlay">
            <p>Connecting peer…</p>
          </div>
        ) : null}
        {inCall && connPhase === 'failed' && failureReason ? (
          <div className="video-chat-webrtc-overlay video-chat-webrtc-overlay--error">
            <p>{failureReason}</p>
            <div className="video-chat-webrtc-actions">
              <button type="button" className="cta-button cta-primary" onClick={handleRetry}>
                Retry connection
              </button>
            </div>
          </div>
        ) : null}
        {lockoutActive ? (
          <div className="video-chat-skip-lockout" role="status">
            <p className="video-chat-skip-lockout-title">Next is temporarily locked</p>
            <p className="video-chat-skip-lockout-text">
              You have used 30 skips in the last hour. Wait{' '}
              <strong>
                {Math.floor(lockoutRemainingSec / 60)}:{String(lockoutRemainingSec % 60).padStart(2, '0')}
              </strong>{' '}
              before skipping again.
            </p>
          </div>
        ) : null}
      </div>
      <video ref={localVideoRef} className="video-chat-local-source" playsInline autoPlay muted />
      <canvas
        ref={localCanvasRef}
        className="video-chat-local-pip z-[5] max-md:!bottom-[calc(6.5rem+env(safe-area-inset-bottom,0px))] max-md:!right-3 max-md:!left-auto max-md:!top-auto max-md:!w-[min(34vw,8rem)] max-md:!max-h-[9.5rem] max-md:!rounded-xl"
        aria-label="Your camera"
      />

      <div className="vc-filter-strip" role="region" aria-label="Filters">
        <div className="vc-filter-strip-head">
          <span className="vc-filter-strip-title">{selectedLabel}</span>
          <label className="vc-filter-voice">
            <input
              type="checkbox"
              checked={pitchEnabled}
              onChange={(e) => setPitchEnabled(e.target.checked)}
            />
            <span>Pitch</span>
          </label>
          {pitchEnabled ? (
            <input
              className="vc-filter-slider"
              type="range"
              min={-6}
              max={8}
              step={1}
              value={pitchSemitones}
              onChange={(e) => setPitchSemitones(Number(e.target.value))}
              aria-label="Pitch shift (semitones)"
            />
          ) : null}
        </div>
        <div className="vc-filter-strip-row">
          {(previews.length ? previews : FILTERS.map((f) => ({ ...f, dataUrl: '' }))).map((f) => (
            <button
              key={f.id}
              type="button"
              className={`vc-filter-chip ${selectedFilter === f.id ? 'is-active' : ''}`}
              onClick={() => setSelectedFilter(f.id)}
              title={f.label}
            >
              <div className="vc-filter-thumb">
                {f.dataUrl ? <img src={f.dataUrl} alt="" /> : <div className="vc-filter-thumb-ph" />}
              </div>
              <div className="vc-filter-label">{f.label}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}
