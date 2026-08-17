import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import MatchingParticles from './MatchingParticles.jsx'
import { useCanvasVideoFilters } from '../hooks/useCanvasVideoFilters.js'
import { ICE_SERVERS } from '../utils/iceServers.js'

const CONNECT_TIMEOUT_MS = 30_000

/**
 * Native RTCPeerConnection video chat (no simple-peer).
 *
 * @typedef {object} VideoChatWebRTCHandle
 * @property {() => void} destroyPeer
 */

/**
 * @param {object} props
 * @param {import('socket.io-client').Socket | null} props.socket
 * @param {string | null} props.roomId
 * @param {string | null} props.peerUserId
 * @param {boolean} props.isOfferer
 * @param {boolean} props.isSearching
 * @param {boolean} [props.micMuted]
 * @param {string} [props.filterId]
 */
const VideoChatWebRTC = forwardRef(function VideoChatWebRTC(
  {
    socket,
    roomId,
    peerUserId,
    isOfferer,
    isSearching,
    micMuted = false,
    filterId = 'none',
  },
  ref,
) {
  const hiddenVideoRef = useRef(null)
  const canvasRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const canvasStreamRef = useRef(null)
  const remoteDescSetRef = useRef(false)
  const pendingIceRef = useRef([])
  const pendingOfferRef = useRef(null)

  const [cameraReady, setCameraReady] = useState(false)
  const [connStatus, setConnStatus] = useState('idle')
  const [mediaError, setMediaError] = useState(null)
  const [retryKey, setRetryKey] = useState(0)

  useCanvasVideoFilters({
    videoRef: hiddenVideoRef,
    canvasRef,
    enabled: cameraReady,
    selectedFilterId: filterId,
    virtualBgUrl: '',
  })

  const attachLocalStream = useCallback((stream) => {
    const hidden = hiddenVideoRef.current
    if (hidden) {
      hidden.srcObject = stream
      hidden.muted = true
      hidden.play?.().catch(() => {})
    }
  }, [])

  const attachRemoteStream = useCallback((stream) => {
    const el = remoteVideoRef.current
    if (!el || !stream) return
    el.srcObject = stream
    el.muted = false
    const p = el.play()
    if (p?.catch) {
      p.catch(() => {
        el.muted = true
        el.play().catch(() => {})
      })
    }
  }, [])

  const destroyPeer = useCallback(() => {
    remoteDescSetRef.current = false
    pendingIceRef.current = []
    pendingOfferRef.current = null
    canvasStreamRef.current = null
    const pc = pcRef.current
    pcRef.current = null
    if (pc) {
      try {
        pc.ontrack = null
        pc.onicecandidate = null
        pc.onconnectionstatechange = null
        pc.close()
      } catch {
        // ignore
      }
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    setConnStatus('idle')
  }, [])

  useImperativeHandle(ref, () => ({ destroyPeer }), [destroyPeer])

  const getStreamForPc = useCallback(() => {
    const raw = localStreamRef.current
    if (!raw) return null
    const useFilter = filterId && filterId !== 'none'
    const canvas = canvasRef.current
    if (useFilter && canvas && canvas.width > 1 && canvas.height > 1) {
      if (!canvasStreamRef.current) {
        canvasStreamRef.current = canvas.captureStream(24)
      }
      const vTrack = canvasStreamRef.current.getVideoTracks()[0]
      const aTrack = raw.getAudioTracks()[0]
      if (vTrack) {
        return new MediaStream([vTrack, aTrack].filter(Boolean))
      }
    }
    return raw
  }, [filterId])

  const replaceOutgoingVideoTrack = useCallback(() => {
    const pc = pcRef.current
    const out = getStreamForPc()
    if (!pc || !out) return
    const vt = out.getVideoTracks()[0]
    if (!vt) return
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    sender?.replaceTrack(vt).catch(() => {})
  }, [getStreamForPc])

  // 1) getUserMedia when component mounts (also when match arrives — stream ready before PC)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        localStreamRef.current = stream
        attachLocalStream(stream)
        setCameraReady(true)
      } catch (e) {
        if (!cancelled) {
          setMediaError(e?.message || 'Could not access camera or microphone.')
        }
      }
    })()
    return () => {
      cancelled = true
      destroyPeer()
      localStreamRef.current?.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
      setCameraReady(false)
    }
  }, [attachLocalStream, destroyPeer])

  useEffect(() => {
    const s = localStreamRef.current
    if (!s) return
    s.getAudioTracks().forEach((t) => {
      t.enabled = !micMuted
    })
  }, [micMuted, cameraReady])

  useEffect(() => {
    canvasStreamRef.current = null
  }, [filterId, roomId])

  useEffect(() => {
    if (!cameraReady || connStatus !== 'connected') return undefined
    replaceOutgoingVideoTrack()
    const id = window.setInterval(replaceOutgoingVideoTrack, 1000)
    return () => window.clearInterval(id)
  }, [filterId, cameraReady, connStatus, replaceOutgoingVideoTrack])

  // 2–7) RTCPeerConnection signaling via Socket.io
  useEffect(() => {
    if (!socket || !roomId || !peerUserId || !cameraReady || mediaError) return undefined

    const localStream = getStreamForPc() || localStreamRef.current
    if (!localStream?.getVideoTracks()?.length) {
      setMediaError('No camera video track.')
      return undefined
    }

    setConnStatus('connecting')
    remoteDescSetRef.current = false
    pendingIceRef.current = []
    pendingOfferRef.current = null

    const connectedRef = { current: false }

    const flushPendingIce = async () => {
      const pc = pcRef.current
      if (!pc || !remoteDescSetRef.current) return
      while (pendingIceRef.current.length) {
        const c = pendingIceRef.current.shift()
        try {
          await pc.addIceCandidate(c)
        } catch (e) {
          console.warn('[webrtc] addIceCandidate failed', e)
        }
      }
    }

    const addIce = async (candidate) => {
      const pc = pcRef.current
      if (!pc || candidate == null) return
      if (!remoteDescSetRef.current) {
        pendingIceRef.current.push(candidate)
        return
      }
      try {
        await pc.addIceCandidate(candidate)
      } catch (e) {
        console.warn('[webrtc] addIceCandidate failed', e)
      }
    }

    const createPeerConnection = () => {
      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS.iceServers,
        iceCandidatePoolSize: ICE_SERVERS.iceCandidatePoolSize ?? 10,
      })
      pcRef.current = pc

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })

      pc.ontrack = (event) => {
        const remote = event.streams?.[0]
        if (!remote) return
        console.log('[webrtc] ontrack — remote stream', {
          isOfferer,
          tracks: remote.getTracks().map((t) => t.kind),
        })
        connectedRef.current = true
        attachRemoteStream(remote)
        setConnStatus('connected')
      }

      pc.onicecandidate = (event) => {
        if (!event.candidate || !socket.connected) return
        socket.emit('ice_candidate', {
          room_id: roomId,
          candidate: event.candidate,
        })
      }

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState
        console.log('[webrtc] connectionState', st, { isOfferer, roomId })
        if (st === 'connected') {
          connectedRef.current = true
          setConnStatus('connected')
        } else if (st === 'failed' || st === 'closed') {
          setConnStatus('failed')
        }
      }

      return pc
    }

    const sendOffer = async (pc) => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('webrtc_offer', {
        room_id: roomId,
        sdp: pc.localDescription,
      })
      console.log('[webrtc] offer sent', { roomId })
    }

    const handleOffer = async (sdp) => {
      let pc = pcRef.current
      if (!pc) {
        pendingOfferRef.current = sdp
        return
      }
      try {
        await pc.setRemoteDescription(sdp)
        remoteDescSetRef.current = true
        await flushPendingIce()
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('webrtc_answer', {
          room_id: roomId,
          sdp: pc.localDescription,
        })
        console.log('[webrtc] answer sent', { roomId })
      } catch (e) {
        console.error('[webrtc] handleOffer failed', e)
        setConnStatus('failed')
      }
    }

    const handleAnswer = async (sdp) => {
      const pc = pcRef.current
      if (!pc) return
      try {
        await pc.setRemoteDescription(sdp)
        remoteDescSetRef.current = true
        await flushPendingIce()
        console.log('[webrtc] answer applied', { roomId })
      } catch (e) {
        console.error('[webrtc] handleAnswer failed', e)
        setConnStatus('failed')
      }
    }

    const onOfferRelay = (payload) => {
      if (isOfferer || payload?.room_id !== roomId) return
      if (!pcRef.current) {
        pendingOfferRef.current = payload.sdp
        return
      }
      handleOffer(payload.sdp)
    }

    const onAnswerRelay = (payload) => {
      if (!isOfferer || payload?.room_id !== roomId) return
      handleAnswer(payload.sdp)
    }

    const onIceRelay = (payload) => {
      if (payload?.room_id !== roomId) return
      addIce(payload.candidate)
    }

    socket.on('webrtc_offer_relay', onOfferRelay)
    socket.on('webrtc_answer_relay', onAnswerRelay)
    socket.on('ice_candidate_relay', onIceRelay)

    const pc = createPeerConnection()

    ;(async () => {
      if (isOfferer) {
        await sendOffer(pc)
      } else if (pendingOfferRef.current) {
        await handleOffer(pendingOfferRef.current)
        pendingOfferRef.current = null
      }

      socket.emit('join_match_room', { room_id: roomId })

      if (!isOfferer && !remoteDescSetRef.current) {
        window.setTimeout(() => {
          socket.emit('webrtc_request_signals', { room_id: roomId })
        }, 1200)
      }
    })().catch((e) => {
      console.error('[webrtc] setup failed', e)
      setConnStatus('failed')
    })

    const timeout = window.setTimeout(() => {
      if (!connectedRef.current && pcRef.current) {
        destroyPeer()
        setRetryKey((k) => k + 1)
      }
    }, CONNECT_TIMEOUT_MS)

    return () => {
      window.clearTimeout(timeout)
      socket.off('webrtc_offer_relay', onOfferRelay)
      socket.off('webrtc_answer_relay', onAnswerRelay)
      socket.off('ice_candidate_relay', onIceRelay)
      destroyPeer()
    }
  }, [
    socket,
    roomId,
    peerUserId,
    isOfferer,
    cameraReady,
    mediaError,
    retryKey,
    attachRemoteStream,
    destroyPeer,
    getStreamForPc,
  ])

  if (mediaError) {
    return (
      <div className="video-chat-webrtc video-chat-webrtc--error">
        <p>{mediaError}</p>
      </div>
    )
  }

  return (
    <div className="video-chat-webrtc video-chat-webrtc--fill">
      <div className="video-chat-webrtc-main">
        <video
          ref={remoteVideoRef}
          className="video-chat-remote"
          playsInline
          autoPlay
          aria-label="Partner video"
        />
        {isSearching ? (
          <div className="video-chat-search-layer">
            <MatchingParticles />
            <p className="video-chat-search-label">Looking for someone…</p>
          </div>
        ) : null}
        {!isSearching && connStatus === 'connecting' ? (
          <div className="video-chat-webrtc-overlay">
            <p>Connecting…</p>
          </div>
        ) : null}
        {!isSearching && connStatus === 'failed' ? (
          <div className="video-chat-webrtc-overlay video-chat-webrtc-overlay--error">
            <p>Connection failed.</p>
            <button type="button" className="cta-button cta-primary" onClick={() => setRetryKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : null}
      </div>

      <video ref={hiddenVideoRef} className="video-chat-local-source" playsInline autoPlay muted />
      <canvas ref={canvasRef} className="video-chat-local-pip" aria-label="Your camera" />
    </div>
  )
})

export default VideoChatWebRTC
