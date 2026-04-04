import { useCallback, useEffect, useState } from 'react'
import { areCameraAndMicrophoneGranted } from '../utils/mediaPermissions'

function MediaPermissionGate({ enabled, children }) {
  const [phase, setPhase] = useState(() => (enabled ? 'checking' : 'ready'))

  const runCheck = useCallback(async () => {
    setPhase('checking')
    try {
      const ok = await areCameraAndMicrophoneGranted()
      setPhase(ok ? 'ok' : 'blocked')
    } catch {
      setPhase('blocked')
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => {
      void runCheck()
    }, 0)
    return () => clearTimeout(t)
  }, [enabled, runCheck])

  if (!enabled) {
    return children
  }

  if (phase === 'checking') {
    return (
      <div className="media-permission-gate" role="status" aria-live="polite">
        <div className="media-permission-gate__panel">
          <div className="media-permission-gate__spinner" aria-hidden="true" />
          <p className="media-permission-gate__checking">Checking camera and microphone…</p>
        </div>
      </div>
    )
  }

  if (phase === 'blocked') {
    return (
      <div className="media-permission-gate" role="dialog" aria-modal="true" aria-labelledby="media-gate-title">
        <div className="media-permission-gate__panel">
          <h1 id="media-gate-title" className="media-permission-gate__title">
            Camera & Microphone Access Required
          </h1>
          <p className="media-permission-gate__message">
            CLOAK needs access to your camera and microphone to connect you with other students.
          </p>

          <button type="button" className="media-permission-gate__btn" onClick={runCheck}>
            I&apos;ve Enabled Permissions
          </button>
        </div>
      </div>
    )
  }

  return children
}

export default MediaPermissionGate
