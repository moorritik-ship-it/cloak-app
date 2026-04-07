import { useMemo, useState } from 'react'
import { getAccessToken } from '../utils/authStorage.js'
import { apiUrl } from '../utils/apiBase'

const CATEGORIES = [
  {
    id: 'inappropriate_behavior',
    label: 'Inappropriate behavior',
  },
  {
    id: 'political_caste_gender_religious',
    label: 'Political / caste / gender / religious discussion',
  },
  {
    id: 'harassment_or_bullying',
    label: 'Harassment or bullying',
  },
  {
    id: 'spam_or_scam',
    label: 'Spam or scam',
  },
  {
    id: 'suspected_underage',
    label: 'Suspected underage user',
  },
  {
    id: 'other',
    label: 'Other (requires description)',
  },
]

/**
 * @param {{
 *  open: boolean,
 *  onClose: () => void,
 *  sessionId: string | null,
 *  reportedUserId: string | null,
 * }} props
 */
export default function ReportUserModal({ open, onClose, sessionId, reportedUserId }) {
  const [category, setCategory] = useState('inappropriate_behavior')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const canSubmit = useMemo(() => {
    if (!sessionId || !reportedUserId) return false
    if (category === 'other') return description.trim().length >= 8
    return true
  }, [sessionId, reportedUserId, category, description])

  if (!open) return null

  const submit = async () => {
    setError(null)
    if (!canSubmit) return
    const token = getAccessToken()
    if (!token) {
      setError('Not signed in.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/report'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sessionId,
          reportedUserId,
          category,
          description: category === 'other' ? description.trim() : description.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message || 'Could not submit report.')
      setDone(true)
      window.setTimeout(() => {
        setDone(false)
        onClose()
      }, 900)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit report.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vc-report-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="vc-report-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vc-report-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vc-report-head">
          <h2 id="vc-report-title">Report user</h2>
          <button type="button" className="vc-report-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="vc-report-sub">
          Submitted <strong>anonymously</strong>. Your identity is never shown to the reported user.
        </p>

        <label className="vc-report-label">
          Category
          <select
            className="vc-report-select"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy || done}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        {category === 'other' ? (
          <label className="vc-report-label">
            Description
            <textarea
              className="vc-report-textarea"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy || done}
              placeholder="Describe what happened…"
            />
          </label>
        ) : null}

        {error ? (
          <p className="vc-report-error" role="alert">
            {error}
          </p>
        ) : null}

        {done ? (
          <p className="vc-report-ok" role="status">
            Thanks — your report was submitted.
          </p>
        ) : null}

        <div className="vc-report-actions">
          <button type="button" className="vc-report-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="vc-report-submit" onClick={submit} disabled={busy || done || !canSubmit}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}
