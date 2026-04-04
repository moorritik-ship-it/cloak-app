import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAccessToken, mergeUserProfile } from '../utils/authStorage'

const MILESTONE_INFO = [
  { points: 1000, reward: 10 },
  { points: 2500, reward: 30 },
  { points: 5000, reward: 75 },
  { points: 10000, reward: 200 },
]

function formatMoney(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '0.00'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatTxDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

function loadRazorpayScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.Razorpay) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load Razorpay'))
    document.body.appendChild(s)
  })
}

function ProfilePage() {
  const navigate = useNavigate()
  const token = getAccessToken()
  const [balance, setBalance] = useState('0')
  const [hasWalletPin, setHasWalletPin] = useState(false)
  const [transactions, setTransactions] = useState([])
  const [cloakScore, setCloakScore] = useState(0)
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [topupInr, setTopupInr] = useState('100')
  const [withdrawInr, setWithdrawInr] = useState('')
  const [upiId, setUpiId] = useState('')
  const [withdrawPin, setWithdrawPin] = useState('')
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [blockedUsers, setBlockedUsers] = useState([])
  const [supportEmail, setSupportEmail] = useState('support@cloak.app')

  const loadWallet = useCallback(async () => {
    const t = getAccessToken()
    if (!t) return
    const res = await fetch('/api/wallet', { headers: { Authorization: `Bearer ${t}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data?.message || 'Could not load wallet.')
      return
    }
    setBalance(String(data.balance ?? '0'))
    setHasWalletPin(Boolean(data.hasWalletPin))
    setTransactions(Array.isArray(data.transactions) ? data.transactions : [])
    mergeUserProfile({
      walletBalance: String(data.balance ?? '0'),
      hasWalletPin: Boolean(data.hasWalletPin),
    })
  }, [])

  const loadMe = useCallback(async () => {
    const t = getAccessToken()
    if (!t) return
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${t}` } })
    const data = await res.json().catch(() => ({}))
    if (res.ok && typeof data.user?.cloakScore === 'number') {
      setCloakScore(data.user.cloakScore)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    setError(null)
    loadWallet()
    loadMe()
  }, [token, loadWallet, loadMe])

  const loadBlocks = useCallback(async () => {
    const t = getAccessToken()
    if (!t) return
    try {
      const res = await fetch('/api/blocks', { headers: { Authorization: `Bearer ${t}` } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return
      if (typeof data.supportEmail === 'string' && data.supportEmail) setSupportEmail(data.supportEmail)
      setBlockedUsers(Array.isArray(data.blocked) ? data.blocked : [])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (!token) return
    loadBlocks()
  }, [token, loadBlocks])

  const handleSetPin = async (e) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const res = await fetch('/api/wallet/set-pin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pin, pinConfirm }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message || 'Could not set PIN.')
      setMessage('Wallet PIN saved. You can withdraw when your balance is ₹100 or more.')
      setPin('')
      setPinConfirm('')
      setHasWalletPin(true)
      mergeUserProfile({ hasWalletPin: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set PIN.')
    } finally {
      setBusy(false)
    }
  }

  const handleTopUp = async () => {
    if (!token) return
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const amt = Number(topupInr)
      const res = await fetch('/api/wallet/topup-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amountInr: amt }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message || 'Could not start top-up.')

      const orderId = data.order_id
      if (String(orderId).startsWith('mock_wt_')) {
        const v = await fetch('/api/wallet/topup-verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: `pay_mock_${Date.now()}`,
            razorpay_signature: 'mock',
          }),
        })
        const vd = await v.json().catch(() => ({}))
        if (!v.ok) throw new Error(vd?.message || 'Verification failed.')
        setBalance(String(vd.balance ?? '0'))
        mergeUserProfile({ walletBalance: String(vd.balance ?? '0') })
        setMessage('Top-up complete (mock payment).')
        await loadWallet()
        return
      }

      await loadRazorpayScript()
      await new Promise((resolve, reject) => {
        const options = {
          key: data.razorpay_key_id,
          amount: data.amount_paise,
          currency: data.currency || 'INR',
          order_id: orderId,
          name: 'CLOAK',
          description: 'Wallet top-up',
          handler: async (response) => {
            try {
              const v = await fetch('/api/wallet/topup-verify', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }),
              })
              const vd = await v.json().catch(() => ({}))
              if (!v.ok) throw new Error(vd?.message || 'Verification failed.')
              setBalance(String(vd.balance ?? '0'))
              mergeUserProfile({ walletBalance: String(vd.balance ?? '0') })
              setMessage('Top-up successful.')
              await loadWallet()
              resolve()
            } catch (err) {
              reject(err instanceof Error ? err : new Error('Payment failed'))
            }
          },
          modal: { ondismiss: () => resolve() },
        }
        const Rzp = window.Razorpay
        if (typeof Rzp !== 'function') {
          reject(new Error('Razorpay failed to load'))
          return
        }
        new Rzp(options).open()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Top-up failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleWithdraw = async (e) => {
    e.preventDefault()
    if (!token) return
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amountInr: Number(withdrawInr),
          upiId,
          pin: withdrawPin,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message || 'Withdrawal failed.')
      setBalance(String(data.balance ?? '0'))
      mergeUserProfile({ walletBalance: String(data.balance ?? '0') })
      setMessage('Withdrawal recorded. Payouts are processed to your UPI by CLOAK.')
      setWithdrawInr('')
      setUpiId('')
      setWithdrawPin('')
      await loadWallet()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <main className="simple-page px-3 py-8 text-base sm:px-4 md:px-6 md:py-10">
        <section className="simple-card">
          <h1>Profile</h1>
          <p>Log in to manage your wallet and settings.</p>
          <button type="button" className="wallet-primary-btn" onClick={() => navigate('/login')}>
            Go to login
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="simple-page profile-page px-3 py-8 text-base sm:px-4 md:px-6 md:py-10">
      <section className="simple-card profile-wallet-card" id="wallet">
        <h1>CLOAK Wallet</h1>
        <p className="profile-wallet-lead">
          Balance: <strong className="profile-wallet-balance">₹{formatMoney(balance)}</strong>
        </p>
        <p className="profile-wallet-sub">
          CloakScore: <strong>{cloakScore.toLocaleString('en-IN')}</strong> — earn wallet rewards at
          milestones.
        </p>

        {error ? (
          <div className="wallet-alert wallet-alert--error" role="alert">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="wallet-alert wallet-alert--ok" role="status">
            {message}
          </div>
        ) : null}

        <div className="wallet-milestones">
          <h2 className="wallet-section-title">Milestone rewards</h2>
          <ul className="wallet-milestone-list">
            {MILESTONE_INFO.map((m) => (
              <li key={m.points}>
                <span>
                  {m.points.toLocaleString('en-IN')} CloakScore points → ₹{m.reward}
                </span>
                {cloakScore >= m.points ? (
                  <span className="wallet-milestone-done">Reached</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="wallet-hint">
            Rewards credit automatically when you cross each threshold. You will get an email when money
            is added.
          </p>
        </div>

        {!hasWalletPin ? (
          <form className="wallet-form" onSubmit={handleSetPin}>
            <h2 className="wallet-section-title">Set wallet PIN (for withdrawals)</h2>
            <p className="wallet-hint">Choose a 4–6 digit PIN. This cannot be changed here yet.</p>
            <label className="wallet-label">
              PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={pin}
                onChange={(ev) => setPin(ev.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <label className="wallet-label">
              Confirm PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={pinConfirm}
                onChange={(ev) => setPinConfirm(ev.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button type="submit" className="wallet-primary-btn" disabled={busy}>
              Save PIN
            </button>
          </form>
        ) : (
          <p className="wallet-hint wallet-pin-set">Wallet PIN is set.</p>
        )}

        <div className="wallet-topup">
          <h2 className="wallet-section-title">Top up (Razorpay)</h2>
          <div className="wallet-row">
            <label className="wallet-label wallet-label--inline">
              Amount (₹)
              <input
                type="number"
                min={10}
                max={50000}
                step={1}
                value={topupInr}
                onChange={(ev) => setTopupInr(ev.target.value)}
              />
            </label>
            <button type="button" className="wallet-secondary-btn" onClick={handleTopUp} disabled={busy}>
              Pay with Razorpay
            </button>
          </div>
        </div>

        <form className="wallet-form" onSubmit={handleWithdraw}>
          <h2 className="wallet-section-title">Withdraw to UPI</h2>
          <p className="wallet-hint">Minimum ₹100. Requires your wallet PIN.</p>
          <label className="wallet-label">
            UPI ID
            <input
              type="text"
              placeholder="you@paytm"
              value={upiId}
              onChange={(ev) => setUpiId(ev.target.value.trim())}
              autoComplete="off"
            />
          </label>
          <label className="wallet-label">
            Amount (₹)
            <input
              type="number"
              min={100}
              step={1}
              value={withdrawInr}
              onChange={(ev) => setWithdrawInr(ev.target.value)}
            />
          </label>
          <label className="wallet-label">
            Wallet PIN
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={withdrawPin}
              onChange={(ev) => setWithdrawPin(ev.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <button type="submit" className="wallet-primary-btn" disabled={busy || !hasWalletPin}>
            Confirm withdrawal
          </button>
        </form>

        <div className="wallet-history">
          <h2 className="wallet-section-title">Transaction history</h2>
          {transactions.length === 0 ? (
            <p className="wallet-hint">No transactions yet.</p>
          ) : (
            <div className="wallet-table-wrap">
              <table className="wallet-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => {
                    const n = Number(t.amount)
                    const sign = n >= 0 ? '+' : ''
                    return (
                      <tr key={t.id}>
                        <td>{formatTxDate(t.createdAt)}</td>
                        <td className={n >= 0 ? 'wallet-credit' : 'wallet-debit'}>
                          {sign}₹{formatMoney(Math.abs(n))}
                        </td>
                        <td>{t.reason}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="simple-card profile-settings-card">
        <h2>Account</h2>
        <div className="wallet-hint" style={{ marginTop: '0.25rem' }}>
          <strong>Blocked users</strong>
          <div style={{ marginTop: '0.35rem' }}>
            {blockedUsers.length === 0 ? (
              <span>No blocked users.</span>
            ) : (
              <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.15rem' }}>
                {blockedUsers.map((u) => (
                  <li key={u.id}>
                    {u.username} <span style={{ opacity: 0.8 }}>({new Date(u.blockedAt).toLocaleDateString()})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ marginTop: '0.65rem' }}>
            To unblock someone, contact support at{' '}
            <a href={`mailto:${supportEmail}`}>
              <strong>{supportEmail}</strong>
            </a>
            .
          </div>
        </div>
      </section>
    </main>
  )
}

export default ProfilePage
