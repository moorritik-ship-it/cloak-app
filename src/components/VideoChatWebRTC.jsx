import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Peer from 'simple-peer'
import MatchingParticles from './MatchingParticles.jsx'
import MatchCountdownOverlay from './MatchCountdownOverlay.jsx'
import { useCloakEngagement } from '../hooks/useCloakEngagement.js'
import { FILTERS, useCanvasVideoFilters } from '../hooks/useCanvasVideoFilters.js'

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

/**
 * @param {object} props
 * @param {import('socket.io-client').Socket} props.socket
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

  const [mediaError, setMediaError] = useState(null)
  const [hasStream, setHasStream] = useState(false)
  const [connPhase, setConnPhase] = useState('connecting')
  const [failureReason, setFailureReason] = useState(null)
  const [retryKey, setRetryKey] = useState(0)

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
      if (data.type === 'offer') {
        socket.emit('webrtc_offer', { room_id: roomId, sdp: data })
      } else if (data.type === 'answer') {
        socket.emit('webrtc_answer', { room_id: roomId, sdp: data })
      } else {
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
    if (!socket || !roomId || !peerUserId || mediaError) return
    const stream = processedStreamRef.current || localStreamRef.current
    if (!stream) return

    answererIceBufferRef.current = []
    offererIceBufferRef.current = []
    answerAppliedRef.current = false

    queueMicrotask(() => {
      setFailureReason(null)
      setConnPhase('connecting')
    })

    socket.emit('join_match_room', { room_id: roomId })

    const flushAnswererIce = () => {
      const p = peerRef.current
      if (!p) return
      const buf = answererIceBufferRef.current
      while (buf.length) {
        const c = buf.shift()
        try {
          p.signal(c)
        } catch {
          // ignore
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
          p.signal(c)
        } catch {
          // ignore
        }
      }
    }

    const attachPeerHandlers = (peer) => {
      peer.on('signal', emitSignal)
      peer.on('stream', (remoteStream) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream
        }
        setConnPhase('live')
      })
      peer.on('connect', () => setConnPhase('live'))
      peer.on('error', (err) => {
        setFailureReason(err?.message || 'WebRTC error')
        setConnPhase('failed')
      })
      peer.on('close', () => {
        setConnPhase('failed')
        setFailureReason('Connection closed.')
      })
    }

    const onOfferRelay = ({ sdp }) => {
      if (isOfferer) return
      if (peerRef.current) {
        try {
          peerRef.current.signal(sdp)
        } catch {
          // ignore
        }
        return
      }
      const peer = new Peer({
        initiator: false,
        trickle: true,
        stream,
        config: ICE_SERVERS,
      })
      peerRef.current = peer
      attachPeerHandlers(peer)
      try {
        peer.signal(sdp)
      } catch (e) {
        setFailureReason(e?.message || 'Failed to apply offer')
        setConnPhase('failed')
      }
      flushAnswererIce()
    }

    const onAnswerRelay = ({ sdp }) => {
      if (!isOfferer) return
      const peer = peerRef.current
      if (!peer) return
      try {
        peer.signal(sdp)
        answerAppliedRef.current = true
        flushOffererIce()
      } catch (e) {
        setFailureReason(e?.message || 'Failed to apply answer')
        setConnPhase('failed')
      }
    }

    const onIceRelay = ({ candidate }) => {
      if (!candidate) return
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
      } catch {
        // ignore
      }
    }

    const onRoomError = (err) => {
      setFailureReason(err?.message || 'Room error')
      setConnPhase('failed')
    }

    const onPeerDisconnected = () => {
      destroyPeer()
      setConnPhase('failed')
      setFailureReason('The other participant disconnected.')
      onPeerDisconnected?.()
    }

    socket.on('webrtc_offer_relay', onOfferRelay)
    socket.on('webrtc_answer_relay', onAnswerRelay)
    socket.on('ice_candidate_relay', onIceRelay)
    socket.on('room_error', onRoomError)
    socket.on('webrtc_peer_disconnected', onPeerDisconnected)

    if (isOfferer) {
      const peer = new Peer({
        initiator: true,
        trickle: true,
        stream,
        config: ICE_SERVERS,
      })
      peerRef.current = peer
      attachPeerHandlers(peer)
    }

    return () => {
      socket.off('webrtc_offer_relay', onOfferRelay)
      socket.off('webrtc_answer_relay', onAnswerRelay)
      socket.off('ice_candidate_relay', onIceRelay)
      socket.off('room_error', onRoomError)
      socket.off('webrtc_peer_disconnected', onPeerDisconnected)
      destroyPeer()
    }
  }, [socket, roomId, peerUserId, mediaError, isOfferer, emitSignal, destroyPeer, onPeerDisconnected, retryKey])

  const handleRetry = () => {
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
