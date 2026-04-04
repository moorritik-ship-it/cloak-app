import { useEffect, useRef } from 'react'

const TICK_MS = 5000
const IDLE_MS = 30_000
const EMIT_SECONDS_PER_TICK = 5

/**
 * Tracks idle (no face OR no input for 30s) and reports engaged seconds to the server for CloakScore.
 * @param {import('socket.io-client').Socket | null} socket
 * @param {string | null} roomId
 * @param {React.RefObject<HTMLVideoElement | null>} localVideoRef
 * @param {boolean} cameraOff
 */
export function useCloakEngagement(socket, roomId, localVideoRef, cameraOff) {
  const lastInputRef = useRef(Date.now())
  const lastFaceOkRef = useRef(Date.now())
  const faceDetectorRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.FaceDetector === 'undefined') return
    try {
      faceDetectorRef.current = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
    } catch {
      faceDetectorRef.current = null
    }
  }, [])

  useEffect(() => {
    const t0 = Date.now()
    lastInputRef.current = t0
    lastFaceOkRef.current = t0
    const onActivity = () => {
      lastInputRef.current = Date.now()
    }
    window.addEventListener('keydown', onActivity, true)
    window.addEventListener('pointerdown', onActivity, true)
    window.addEventListener('mousemove', onActivity, true)
    return () => {
      window.removeEventListener('keydown', onActivity, true)
      window.removeEventListener('pointerdown', onActivity, true)
      window.removeEventListener('mousemove', onActivity, true)
    }
  }, [roomId])

  useEffect(() => {
    if (!socket?.connected || !roomId) return undefined

    const tick = async () => {
      const now = Date.now()
      const vid = localVideoRef?.current

      let faceOk = Boolean(vid && vid.videoWidth > 0 && !cameraOff)
      if (faceOk && faceDetectorRef.current && vid.readyState >= 2) {
        try {
          const faces = await faceDetectorRef.current.detect(vid)
          faceOk = faces.length > 0
        } catch {
          faceOk = vid.videoWidth > 0 && !cameraOff
        }
      } else if (!cameraOff && vid?.videoWidth > 0) {
        faceOk = true
      }

      if (faceOk) {
        lastFaceOkRef.current = now
      }

      const idleByFace = now - lastFaceOkRef.current > IDLE_MS
      const idleByInput = now - lastInputRef.current > IDLE_MS
      const idle = idleByFace || idleByInput

      if (!idle) {
        socket.emit('cloak_engagement_delta', {
          room_id: roomId,
          delta_seconds: EMIT_SECONDS_PER_TICK,
        })
      }
    }

    const id = window.setInterval(() => {
      tick().catch(() => {})
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [socket, roomId, cameraOff, localVideoRef])
}
