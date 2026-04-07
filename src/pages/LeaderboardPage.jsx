import { useEffect, useMemo, useState } from 'react'
import { getAccessToken, getUserProfileJson, mergeUserProfile } from '../utils/authStorage'
import { apiUrl } from '../utils/apiBase'

function readStoredProfile() {
  try {
    const raw = getUserProfileJson()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'all', label: 'All Time' },
]

function LeaderboardPage() {
  const [period, setPeriod] = useState('today')
  const [entries, setEntries] = useState([])
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [anonymous, setAnonymous] = useState(() => Boolean(readStoredProfile()?.leaderboardAnonymous))

  const token = useMemo(() => getAccessToken(), [])
  const isAuthed = Boolean(token)

  const load = async (p, { silent } = { silent: false }) => {
    if (!token) return
    if (!silent) setLoading(true)
    setError('')
    try {
      const resp = await fetch(apiUrl(`/api/leaderboard/college?period=${encodeURIComponent(p)}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data?.message || 'Failed to load leaderboard.')
      setEntries(Array.isArray(data?.entries) ? data.entries : [])
      setMe(data?.me || null)
    } catch (e) {
      setError(e?.message || 'Failed to load leaderboard.')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    load(period)
    const id = window.setInterval(() => {
      load(period, { silent: true }).catch(() => {})
    }, 15 * 60 * 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const syncMe = async () => {
      try {
        const resp = await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok) return
        const u = data?.user
        if (cancelled) return
        if (typeof u?.leaderboardAnonymous === 'boolean') {
          setAnonymous(u.leaderboardAnonymous)
          mergeUserProfile({ leaderboardAnonymous: u.leaderboardAnonymous })
        }
      } catch {
        // ignore
      }
    }
    syncMe()
    return () => {
      cancelled = true
    }
  }, [token])

  const handleToggleAnonymous = async () => {
    if (!token) return
    const next = !anonymous
    setAnonymous(next)
    try {
      const resp = await fetch(apiUrl('/api/leaderboard/anonymous'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ anonymous: next }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data?.message || 'Failed to update setting.')
      if (typeof data?.leaderboardAnonymous === 'boolean') {
        setAnonymous(data.leaderboardAnonymous)
        mergeUserProfile({ leaderboardAnonymous: data.leaderboardAnonymous })
      }
      load(period, { silent: true }).catch(() => {})
    } catch (e) {
      setAnonymous((v) => !v)
      setError(e?.message || 'Failed to update setting.')
    }
  }

  const inTop10 = Boolean(me?.rank && me.rank <= 10)

  return (
    <main className="simple-page px-3 py-8 text-base sm:px-4 md:px-6 md:py-10">
      <section className="simple-card leaderboard-page-card">
        <h1>College Leaderboard</h1>
        <p>Only users from your college are shown.</p>

        {!isAuthed ? (
          <div className="leaderboard-empty">Please log in to view your college leaderboard.</div>
        ) : (
          <>
            <div className="leaderboard-controls">
              <div className="leaderboard-tabs" role="tablist" aria-label="Leaderboard time range">
                {PERIODS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`leaderboard-tab ${period === t.id ? 'is-active' : ''}`}
                    onClick={() => setPeriod(t.id)}
                    disabled={loading}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={`leaderboard-anon-toggle ${anonymous ? 'is-on' : ''}`}
                onClick={handleToggleAnonymous}
                disabled={loading}
              >
                {anonymous ? 'Anonymous: On' : 'Anonymous: Off'}
              </button>
            </div>

            {error ? <div className="leaderboard-error">{error}</div> : null}

            <div className="leaderboard-table" aria-label="College leaderboard entries">
              <div className="leaderboard-table-head">
                <div>Rank</div>
                <div>User</div>
                <div className="lb-right">CloakScore</div>
                <div className="lb-right">Sessions</div>
              </div>
              {(loading ? Array.from({ length: 10 }) : entries).map((row, idx) => {
                if (loading) {
                  return (
                    <div key={`sk_${idx}`} className="leaderboard-table-row is-skeleton">
                      <div>—</div>
                      <div>Loading…</div>
                      <div className="lb-right">—</div>
                      <div className="lb-right">—</div>
                    </div>
                  )
                }
                return (
                  <div
                    key={row.id}
                    className={`leaderboard-table-row ${row.isMe ? 'is-me' : ''}`}
                  >
                    <div>#{row.rank}</div>
                    <div>{row.username}</div>
                    <div className="lb-right">{row.cloakScore}</div>
                    <div className="lb-right">{row.sessions}</div>
                  </div>
                )
              })}
            </div>

            {!inTop10 && me?.id ? (
              <div className="leaderboard-me">
                <div className="leaderboard-me-title">Your rank</div>
                <div className="leaderboard-table-row is-me">
                  <div>#{me.rank}</div>
                  <div>{me.username}</div>
                  <div className="lb-right">{me.cloakScore}</div>
                  <div className="lb-right">{me.sessions}</div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

export default LeaderboardPage
