import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MediaPermissionGate from '../components/MediaPermissionGate'
import DashboardNetworkBackground from '../components/DashboardNetworkBackground'
import PreChatMatchModal from '../components/PreChatMatchModal'
import CommunityGuidelinesModal from '../components/CommunityGuidelinesModal'
import AnimatedCloakScore from '../components/AnimatedCloakScore'
import { useToast } from '../hooks/useToast'
import { REMEMBERED_DISPLAY_NAME_KEY } from '../utils/sessionDisplayName'
import { getAccessToken, getUserProfileJson, mergeUserProfile } from '../utils/authStorage'
import { apiUrl } from '../utils/apiBase'

function formatMoney(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '0.00'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function isoDateLocal(d = new Date()) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function subtractDays(dateIso, days) {
  const [y, m, d] = dateIso.split('-').map((x) => Number(x))
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - days)
  return isoDateLocal(dt)
}

function readStoredProfile() {
  try {
    const raw = getUserProfileJson()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function Dashboard() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const prevCloakRef = useRef(null)

  /** Sync read so post-login first paint is authed — media gate runs before dashboard content */
  const [profile] = useState(() => readStoredProfile())
  const [cloakScore, setCloakScore] = useState(() => readStoredProfile()?.cloakScore ?? 0)
  const [streak, setStreak] = useState(1)
  const [sessionsToday, setSessionsToday] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [preChatOpen, setPreChatOpen] = useState(false)
  const [preChatModalKey, setPreChatModalKey] = useState(0)
  const [rememberedDisplayName, setRememberedDisplayName] = useState('')
  const [guidelinesOpen, setGuidelinesOpen] = useState(false)
  const [pendingDisplayName, setPendingDisplayName] = useState('')
  const [walletBalance, setWalletBalance] = useState(() => readStoredProfile()?.walletBalance ?? '0')

  useEffect(() => {
    if (prevCloakRef.current === null) {
      prevCloakRef.current = cloakScore
      return
    }
    const prev = prevCloakRef.current
    const delta = cloakScore - prev
    if (delta > 0 && (prev > 0 || delta <= 25)) {
      showToast(`+${delta} CloakScore`)
    }
    prevCloakRef.current = cloakScore
  }, [cloakScore, showToast])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBERED_DISPLAY_NAME_KEY)
      if (typeof saved === 'string' && saved) setRememberedDisplayName(saved)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (!profile?.id) return
    const token = getAccessToken()
    if (!token) return
    let cancelled = false

    const runDailyLogin = async () => {
      try {
        const res = await fetch(apiUrl('/api/cloak/daily-login'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.status === 200 && data.alreadyClaimed) {
          if (typeof data.cloakScore === 'number') {
            setCloakScore(data.cloakScore)
            mergeUserProfile({ cloakScore: data.cloakScore })
          }
          return
        }
        if (res.status === 202 && data.queued) {
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 450))
            if (cancelled) return
            const me = await fetch(apiUrl('/api/me'), {
              headers: { Authorization: `Bearer ${token}` },
            })
            const mj = await me.json().catch(() => ({}))
            const u = mj?.user
            if (u && typeof u.cloakScore === 'number') {
              setCloakScore(u.cloakScore)
              if (u.walletBalance != null) setWalletBalance(String(u.walletBalance))
              mergeUserProfile({
                cloakScore: u.cloakScore,
                cloakStreakDays: u.cloakStreakDays,
                lastDailyRewardIstDate: u.lastDailyRewardIstDate,
                walletBalance: u.walletBalance != null ? String(u.walletBalance) : undefined,
                hasWalletPin: u.hasWalletPin,
              })
              break
            }
          }
        }
      } catch {
        // ignore
      }
    }

    runDailyLogin()
    return () => {
      cancelled = true
    }
  }, [profile?.id])

  useEffect(() => {
    if (!profile?.id) return

    const key = `cloak_daily_login_${profile.id}`
    const today = isoDateLocal()
    const yesterday = subtractDays(today, 1)

    let nextStreak = 1
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.lastDate === today) {
          nextStreak = Number(parsed?.streak || 1)
        } else if (parsed?.lastDate === yesterday) {
          nextStreak = Number(parsed?.streak || 1) + 1
        }
      }
    } catch {
      nextStreak = 1
    }

    localStorage.setItem(key, JSON.stringify({ lastDate: today, streak: nextStreak }))
    setStreak(nextStreak)
  }, [profile])

  useEffect(() => {
    let cancelled = false
    const token = getAccessToken()
    if (!profile?.id || !token) return

    const load = async () => {
      try {
        const [dashResp, lbResp] = await Promise.all([
          fetch(apiUrl('/api/dashboard/summary'), {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(apiUrl('/api/leaderboard/college?period=today'), {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          }),
        ])

        const dash = await dashResp.json().catch(() => ({}))
        const lb = await lbResp.json().catch(() => ({}))
        if (!dashResp.ok) throw new Error(dash?.message || 'Failed to load dashboard.')

        if (cancelled) return
        if (typeof dash.sessionsToday === 'number') setSessionsToday(dash.sessionsToday)
        const entries = Array.isArray(lb?.entries) ? lb.entries : []
        setLeaderboard(entries.slice(0, 5))
      } catch {
        if (!cancelled) setSessionsToday(0)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [profile?.id])

  useEffect(() => {
    if (!profile?.id) return
    const token = getAccessToken()
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const me = await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } })
        const mj = await me.json().catch(() => ({}))
        if (cancelled || !me.ok) return
        const u = mj?.user
        if (!u) return
        if (typeof u.cloakScore === 'number') setCloakScore(u.cloakScore)
        if (u.walletBalance != null) setWalletBalance(String(u.walletBalance))
        mergeUserProfile({
          cloakScore: u.cloakScore,
          walletBalance: u.walletBalance != null ? String(u.walletBalance) : undefined,
          hasWalletPin: u.hasWalletPin,
          cloakStreakDays: u.cloakStreakDays,
          lastDailyRewardIstDate: u.lastDailyRewardIstDate,
        })
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profile?.id])

  const isAuthed = Boolean(profile?.id)

  const handleFindMatchClick = () => {
    if (!isAuthed) {
      navigate('/login')
      return
    }
    setPreChatModalKey((k) => k + 1)
    setPreChatOpen(true)
  }

  const handlePreChatConfirm = ({ username, remember }) => {
    try {
      if (remember) {
        localStorage.setItem(REMEMBERED_DISPLAY_NAME_KEY, username)
        setRememberedDisplayName(username)
      } else {
        localStorage.removeItem(REMEMBERED_DISPLAY_NAME_KEY)
        setRememberedDisplayName('')
      }
    } catch {
      // ignore storage errors
    }
    setPendingDisplayName(username)
    setPreChatOpen(false)
    setGuidelinesOpen(true)
  }

  const handleGuidelinesGoBack = () => {
    setGuidelinesOpen(false)
    setPreChatModalKey((k) => k + 1)
    setPreChatOpen(true)
  }

  const handleGuidelinesAcknowledge = async () => {
    const token = getAccessToken()
    if (!token) {
      throw new Error('Not signed in. Please log in again.')
    }
    const res = await fetch(apiUrl('/api/cloak/guidelines/acknowledge'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.message || 'Could not save acknowledgment.')
    }
    setGuidelinesOpen(false)
    navigate('/video-chat', { state: { displayName: pendingDisplayName } })
  }

  return (
    <MediaPermissionGate enabled={isAuthed}>
      <main className="dash-page relative min-h-[calc(100dvh-4.5rem)] w-full min-w-0 max-w-[100vw] overflow-x-hidden px-3 py-5 pb-8 text-base sm:px-4 lg:px-6 lg:py-8">
        <DashboardNetworkBackground />

        <header className="dash-header dash-header--premium relative z-[1] mx-auto mb-5 flex w-full max-w-7xl flex-col gap-3 sm:mb-6 md:flex-row md:items-start md:justify-between lg:mb-8">
          <div className="dash-cloak-hero min-w-0">
            <span className="dash-cloak-label text-xs sm:text-sm">CloakScore</span>
            <AnimatedCloakScore value={cloakScore} />
          </div>

          <div className="dash-header-cluster w-full min-w-0 md:w-auto md:max-w-none">
            <button
              type="button"
              className="dash-wallet-chip min-h-12 w-full md:w-auto md:min-h-0"
              onClick={() => navigate('/profile#wallet')}
              title="Open wallet"
            >
              <span className="dash-wallet-label">Wallet</span>
              <span className="dash-wallet-value">₹{formatMoney(walletBalance)}</span>
            </button>

            <div className="dash-quick-stats w-full flex-wrap justify-stretch gap-2 sm:justify-end md:w-auto md:justify-end">
              <div className="dash-stat-pill min-h-12 min-w-0 flex-1 md:min-h-0 md:flex-none md:min-w-[118px]">
                <span className="dash-stat-label text-xs sm:text-[0.72rem]">Sessions today</span>
                <span className="dash-stat-value text-base sm:text-lg">
                  {sessionsToday === null ? '—' : sessionsToday}
                </span>
              </div>
              <div className="dash-stat-pill min-h-12 min-w-0 flex-1 md:min-h-0 md:flex-none md:min-w-[118px]">
                <span className="dash-stat-label text-xs sm:text-[0.72rem]">Streak</span>
                <span className="dash-stat-value text-base sm:text-lg">{streak}d</span>
              </div>
            </div>
          </div>
        </header>

        <section className="dash-body relative z-[1] mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
          <div className="dash-center flex min-h-[200px] w-full min-w-0 flex-1 items-center justify-center sm:min-h-[240px] lg:min-h-[320px]">
            {!isAuthed ? (
              <div className="dash-auth-mock w-full max-w-md px-1 text-center sm:px-0">
                <h2 className="text-xl sm:text-2xl">Login required</h2>
                <p className="mt-1 text-sm sm:text-base">Request an OTP to unlock your match.</p>
                <button
                  type="button"
                  className="find-match-btn mt-4 min-h-12 w-full max-w-full sm:max-w-xs"
                  onClick={handleFindMatchClick}
                >
                  Find Match
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="find-match-btn find-match-btn--xl min-h-12 w-full max-w-full sm:max-w-md lg:w-auto lg:max-w-none"
                onClick={handleFindMatchClick}
              >
                Find Match
              </button>
            )}
          </div>

          <aside
            className="leaderboard-widget leaderboard-widget--compact w-full min-w-0 shrink-0 overflow-x-hidden lg:w-[300px] lg:max-w-[300px]"
            aria-label="College leaderboard"
          >
            <div className="leaderboard-title">
              <button
                type="button"
                className="leaderboard-link"
                onClick={() => navigate('/leaderboard')}
              >
                Your college · Top 5
              </button>
            </div>
            <div className="leaderboard-list">
              {leaderboard.map((row) => (
                <div key={row.id ?? row.rank} className="leaderboard-row">
                  <div className="leaderboard-rank">#{row.rank}</div>
                  <div className="leaderboard-name">{row.username}</div>
                  <div className="leaderboard-score">{row.cloakScore}</div>
                  <div className="leaderboard-sessions">{row.sessions}</div>
                </div>
              ))}
            </div>
          </aside>
        </section>

        <PreChatMatchModal
          key={preChatModalKey}
          open={preChatOpen && isAuthed && !guidelinesOpen}
          onClose={() => setPreChatOpen(false)}
          onConfirm={handlePreChatConfirm}
          initialUsername={rememberedDisplayName}
        />

        <CommunityGuidelinesModal
          open={guidelinesOpen && isAuthed}
          onGoBack={handleGuidelinesGoBack}
          onAcknowledge={handleGuidelinesAcknowledge}
        />
      </main>
    </MediaPermissionGate>
  )
}

export default Dashboard
