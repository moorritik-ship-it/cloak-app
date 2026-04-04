import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion as Motion, AnimatePresence } from 'framer-motion'

const GUIDELINES_COPY = {
  intro:
    'CLOAK is exclusively for study discussions and improving communication skills.',
  prohibitedLabel: 'Prohibited:',
  prohibited: [
    'Political discussions',
    'Gender-based remarks',
    'Caste-based remarks',
    'Religious discussions',
    'Hate speech',
    'Harassment',
  ],
}

/**
 * Mandatory modal — no backdrop dismiss, no outside click. Spring slide-in.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onGoBack
 * @param {() => Promise<void>} props.onAcknowledge
 */
export default function CommunityGuidelinesModal({ open, onGoBack, onAcknowledge }) {
  const titleId = useId()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setSubmitting(false)
      setError('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const handleUnderstand = async () => {
    setError('')
    setSubmitting(true)
    try {
      await onAcknowledge()
    } catch (e) {
      setError(e?.message || 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="guidelines-modal-root" aria-hidden={!open}>
          <Motion.div
            className="guidelines-modal-scrim guidelines-modal-scrim--motion"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              type: 'spring',
              damping: 28,
              stiffness: 260,
              mass: 0.9,
            }}
            aria-hidden
          />
          <div className="guidelines-modal-layer">
            <Motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="guidelines-modal-card"
              initial={{ y: 72, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 48, opacity: 0 }}
              transition={{
                type: 'spring',
                damping: 22,
                stiffness: 340,
                mass: 0.82,
              }}
            >
              <h2 id={titleId} className="guidelines-modal-title">
                Community Guidelines — Please Read Before You Connect
              </h2>

              <div className="guidelines-modal-body">
                <p className="guidelines-modal-intro">{GUIDELINES_COPY.intro}</p>
                <p className="guidelines-modal-prohibited-label">{GUIDELINES_COPY.prohibitedLabel}</p>
                <ul className="guidelines-modal-list">
                  {GUIDELINES_COPY.prohibited.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              {error ? (
                <p className="guidelines-modal-error" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="guidelines-modal-actions">
                <button
                  type="button"
                  className="guidelines-btn-back"
                  onClick={onGoBack}
                  disabled={submitting}
                >
                  Go Back
                </button>
                <button
                  type="button"
                  className="guidelines-btn-confirm"
                  onClick={handleUnderstand}
                  disabled={submitting}
                >
                  {submitting ? 'Saving…' : 'I Understand — Find My Match'}
                </button>
              </div>
            </Motion.div>
          </div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
