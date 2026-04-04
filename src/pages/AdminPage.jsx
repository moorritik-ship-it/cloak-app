import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAccessToken, getUserProfileJson, mergeUserProfile } from '../utils/authStorage'

function readStoredProfile() {
  try {
    const raw = getUserProfileJson()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function formatMoney(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '0.00'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const TABS = [
  { id: 'stats', label: 'Platform Stats' },
  { id: 'colleges', label: 'College Management' },
  { id: 'reports', label: 'Reports Queue' },
  { id: 'users', label: 'User Management' },
]

export default function AdminPage() {
  const navigate = useNavigate()
  const token = useMemo(() => getAccessToken(), [])
  const [me, setMe] = useState(() => readStoredProfile())
  const [tab, setTab] = useState('stats')
  const [error, setError] = useState('')

  const [stats, setStats] = useState(null)
  const [colleges, setColleges] = useState([])
  const [newCollege, setNewCollege] = useState({ name: '', domain: '', emailFormatPattern: '' })
  const [reports, setReports] = useState([])
  const [userQuery, setUserQuery] = useState('')
  const [userResults, setUserResults] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)

  useEffect(() => {
    if (!token) {
      navigate('/dashboard')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) throw new Error(data?.message || 'Could not load profile.')
        setMe(data.user)
        mergeUserProfile(data.user)
        if (!data.user?.isAdmin) {
          navigate('/dashboard')
        }
      } catch (e) {
        if (!cancelled) navigate('/dashboard')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, navigate])

  const api = async (path, opts = {}) => {
    setError('')
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.message || 'Request failed.')
    return data
  }

  useEffect(() => {
    if (!token || !me?.isAdmin) return
    let cancelled = false
    ;(async () => {
      try {
        if (tab === 'stats') {
          const s = await api('/api/admin/stats')
          if (!cancelled) setStats(s)
        } else if (tab === 'colleges') {
          const c = await api('/api/admin/colleges')
          if (!cancelled) setColleges(Array.isArray(c.colleges) ? c.colleges : [])
        } else if (tab === 'reports') {
          const r = await api('/api/admin/reports?status=open&take=100')
          if (!cancelled) setReports(Array.isArray(r.reports) ? r.reports : [])
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Request failed.')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token, me?.isAdmin])

  if (!token) return null
  if (!me?.isAdmin) return null

  return (
    <main className="simple-page admin-page px-3 py-8 text-base sm:px-4 md:px-6 md:py-10">
      <section className="simple-card admin-card">
        <h1>Admin</h1>
        <p>Restricted area. Admin actions are audited in the database where applicable.</p>

        <div className="leaderboard-controls">
          <div className="leaderboard-tabs" role="tablist" aria-label="Admin sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`leaderboard-tab ${tab === t.id ? 'is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="wallet-secondary-btn" onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </button>
        </div>

        {error ? (
          <div className="leaderboard-error" role="alert">
            {error}
          </div>
        ) : null}

        {tab === 'stats' ? (
          <div className="admin-stats-grid">
            <div className="admin-stat-card">
              <div className="admin-stat-label">Total users</div>
              <div className="admin-stat-value">{stats?.totalUsers ?? '—'}</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-label">Daily active users</div>
              <div className="admin-stat-value">{stats?.dailyActiveUsers ?? '—'}</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-label">Sessions today</div>
              <div className="admin-stat-value">{stats?.totalSessionsToday ?? '—'}</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-label">Revenue today</div>
              <div className="admin-stat-value">₹{formatMoney(stats?.totalRevenueToday ?? 0)}</div>
            </div>
          </div>
        ) : null}

        {tab === 'colleges' ? (
          <>
            <h2 style={{ marginTop: '1.25rem' }}>Colleges</h2>
            <div className="admin-college-form">
              <input
                value={newCollege.name}
                onChange={(e) => setNewCollege((p) => ({ ...p, name: e.target.value }))}
                placeholder="College name"
              />
              <input
                value={newCollege.domain}
                onChange={(e) => setNewCollege((p) => ({ ...p, domain: e.target.value }))}
                placeholder="Domain (e.g. nitj.ac.in)"
              />
              <input
                value={newCollege.emailFormatPattern}
                onChange={(e) => setNewCollege((p) => ({ ...p, emailFormatPattern: e.target.value }))}
                placeholder="Email regex (optional)"
              />
              <button
                type="button"
                className="wallet-primary-btn"
                onClick={async () => {
                  try {
                    await api('/api/admin/colleges', { method: 'POST', body: JSON.stringify(newCollege) })
                    setNewCollege({ name: '', domain: '', emailFormatPattern: '' })
                    const c = await api('/api/admin/colleges')
                    setColleges(Array.isArray(c.colleges) ? c.colleges : [])
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Failed.')
                  }
                }}
              >
                Add college
              </button>
            </div>

            <div className="admin-table">
              <div className="admin-table-head">
                <div>Name</div>
                <div>Domain</div>
                <div>Status</div>
                <div />
              </div>
              {colleges.map((c) => (
                <div key={c.id} className="admin-table-row">
                  <div>{c.name}</div>
                  <div>{c.domain}</div>
                  <div>{c.isActive ? 'Active' : 'Inactive'}</div>
                  <div className="lb-right">
                    <button
                      type="button"
                      className="wallet-secondary-btn"
                      onClick={async () => {
                        try {
                          await api(`/api/admin/colleges/${c.id}/toggle`, {
                            method: 'POST',
                            body: JSON.stringify({ isActive: !c.isActive }),
                          })
                          const next = await api('/api/admin/colleges')
                          setColleges(Array.isArray(next.colleges) ? next.colleges : [])
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Failed.')
                        }
                      }}
                    >
                      {c.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === 'reports' ? (
          <>
            <h2 style={{ marginTop: '1.25rem' }}>Pending reports</h2>
            <div className="admin-table">
              <div className="admin-table-head">
                <div>When</div>
                <div>Category</div>
                <div>Reported user</div>
                <div />
              </div>
              {reports.map((r) => (
                <div key={r.id} className="admin-table-row">
                  <div>{new Date(r.createdAt).toLocaleString()}</div>
                  <div>{r.category}</div>
                  <div>{r.reportedUser?.email}</div>
                  <div className="lb-right" style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="wallet-secondary-btn"
                      onClick={async () => {
                        await api(`/api/admin/reports/${r.id}/action`, {
                          method: 'POST',
                          body: JSON.stringify({ action: 'dismiss' }),
                        })
                        const next = await api('/api/admin/reports?status=open&take=100')
                        setReports(next.reports || [])
                      }}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="wallet-secondary-btn"
                      onClick={async () => {
                        await api(`/api/admin/reports/${r.id}/action`, {
                          method: 'POST',
                          body: JSON.stringify({ action: 'warn' }),
                        })
                        const next = await api('/api/admin/reports?status=open&take=100')
                        setReports(next.reports || [])
                      }}
                    >
                      Warn
                    </button>
                    <button
                      type="button"
                      className="wallet-primary-btn"
                      onClick={async () => {
                        await api(`/api/admin/reports/${r.id}/action`, {
                          method: 'POST',
                          body: JSON.stringify({ action: 'ban14' }),
                        })
                        const next = await api('/api/admin/reports?status=open&take=100')
                        setReports(next.reports || [])
                      }}
                    >
                      Ban 14d
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === 'users' ? (
          <>
            <h2 style={{ marginTop: '1.25rem' }}>User search</h2>
            <div className="admin-user-search">
              <input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search by email or username…"
              />
              <button
                type="button"
                className="wallet-secondary-btn"
                onClick={async () => {
                  const out = await api(`/api/admin/users/search?q=${encodeURIComponent(userQuery)}`)
                  setUserResults(out.users || [])
                }}
              >
                Search
              </button>
            </div>

            {userResults.length ? (
              <div className="admin-table" style={{ marginTop: '0.75rem' }}>
                <div className="admin-table-head">
                  <div>Email</div>
                  <div>CloakScore</div>
                  <div>Banned</div>
                  <div />
                </div>
                {userResults.map((u) => (
                  <div key={u.id} className="admin-table-row">
                    <div>{u.email}</div>
                    <div>{u.cloakScore}</div>
                    <div>{u.isBanned ? 'Yes' : 'No'}</div>
                    <div className="lb-right">
                      <button
                        type="button"
                        className="wallet-secondary-btn"
                        onClick={async () => {
                          const detail = await api(`/api/admin/users/${u.id}`)
                          setSelectedUser(detail)
                        }}
                      >
                        View
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {selectedUser?.user ? (
              <div className="admin-user-detail">
                <h3 style={{ margin: '1rem 0 0.25rem' }}>{selectedUser.user.email}</h3>
                <div className="wallet-hint">
                  Sessions: {selectedUser.sessions?.length || 0} · Reports against: {selectedUser.reportsAgainst?.length || 0}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                  <button
                    type="button"
                    className="wallet-primary-btn"
                    onClick={async () => {
                      await api(`/api/admin/users/${selectedUser.user.id}/ban`, {
                        method: 'POST',
                        body: JSON.stringify({ days: 14 }),
                      })
                      const detail = await api(`/api/admin/users/${selectedUser.user.id}`)
                      setSelectedUser(detail)
                    }}
                  >
                    Ban 14d
                  </button>
                  <button
                    type="button"
                    className="wallet-secondary-btn"
                    onClick={async () => {
                      await api(`/api/admin/users/${selectedUser.user.id}/unban`, { method: 'POST' })
                      const detail = await api(`/api/admin/users/${selectedUser.user.id}`)
                      setSelectedUser(detail)
                    }}
                  >
                    Unban
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  )
}

