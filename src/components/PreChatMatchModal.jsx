import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion as Motion, AnimatePresence } from 'framer-motion'
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  sanitizeDisplayNameInput,
  validateDisplayName,
  generateRandomAdjectiveAnimal,
} from '../utils/sessionDisplayName'

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {(payload: { username: string, remember: boolean }) => void} props.onConfirm
 * @param {string} [props.initialUsername]
 */
export default function PreChatMatchModal({ open, onClose, onConfirm, initialUsername = '' }) {
  const titleId = useId()
  const inputRef = useRef(null)
  const [username, setUsername] = useState(() => sanitizeDisplayNameInput(initialUsername))
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const len = username.length
  const counterText = `${len}/${DISPLAY_NAME_MAX}`

  const handleInput = (e) => {
    setUsername(sanitizeDisplayNameInput(e.target.value))
    setError('')
  }

  const handleRandom = () => {
    let next = generateRandomAdjectiveAnimal()
    let guard = 0
    while (guard < 30) {
      const v = validateDisplayName(next)
      if (v.ok) break
      next = generateRandomAdjectiveAnimal()
      guard += 1
    }
    setUsername(sanitizeDisplayNameInput(next))
    setError('')
  }

  const handleConfirm = () => {
    const v = validateDisplayName(username)
    if (!v.ok) {
      setError(v.message)
      return
    }
    onConfirm({ username: username.trim(), remember })
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <Motion.div
          key="prechat-match-modal"
          className="prechat-modal-root"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <button
            type="button"
            className="prechat-modal-backdrop"
            aria-label="Close"
            onClick={onClose}
          />
          <div className="prechat-modal-center" role="presentation">
            <Motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="prechat-modal-card"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: 'spring', damping: 26, stiffness: 320 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id={titleId} className="prechat-modal-title">
                What should we call you today?
              </h2>

              <div className="prechat-modal-field">
                <label htmlFor="prechat-username" className="prechat-modal-label">
                  Username
                </label>
                <div className="prechat-modal-input-wrap">
                  <input
                    ref={inputRef}
                    id="prechat-username"
                    type="text"
                    autoComplete="username"
                    maxLength={DISPLAY_NAME_MAX}
                    minLength={DISPLAY_NAME_MIN}
                    value={username}
                    onChange={handleInput}
                    className="prechat-modal-input"
                    placeholder={`${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters`}
                  />
                  <span className="prechat-modal-counter" aria-live="polite">
                    {counterText}
                  </span>
                </div>
                {error ? (
                  <p className="prechat-modal-error" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                className="prechat-btn-random"
                onClick={handleRandom}
              >
                Generate Random Name
              </button>

              <label className="prechat-remember">
                <input
                  type="checkbox"
                  className="prechat-remember-input"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span className="prechat-remember-track" aria-hidden>
                  <span className="prechat-remember-thumb" />
                </span>
                <span className="prechat-remember-label">Remember this name for future sessions</span>
              </label>

              <div className="prechat-modal-actions">
                <button type="button" className="prechat-btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="prechat-btn-primary" onClick={handleConfirm}>
                  Confirm
                </button>
              </div>
            </Motion.div>
          </div>
        </Motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
