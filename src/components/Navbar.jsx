import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import './Navbar.css'

const NAV_ITEMS = [
  { to: '/', label: 'Home', end: true },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/video-chat', label: 'Video Chat' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/profile', label: 'Profile' },
]

function navLinkClass(isActive) {
  return isActive ? 'cloak-navbar__link active' : 'cloak-navbar__link'
}

function AuthControls({ onDone }) {
  const navigate = useNavigate()
  const go = () => {
    navigate('/login')
    onDone?.()
  }
  return (
    <>
      <button type="button" className="cloak-navbar__btn cloak-navbar__btn--ghost" onClick={go}>
        Login
      </button>
      <button type="button" className="cloak-navbar__btn cloak-navbar__btn--primary" onClick={go}>
        Sign Up
      </button>
    </>
  )
}

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <header id="cloak-navbar" className="cloak-navbar">
      <div className="cloak-navbar__container">
        <div className="cloak-navbar__bar">
          <Link to="/" className="cloak-navbar__logo" onClick={close}>
            CLOAK
          </Link>

          <nav className="cloak-navbar__main" aria-label="Main navigation">
            {NAV_ITEMS.map(({ to, label, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => navLinkClass(isActive)} onClick={close}>
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="cloak-navbar__actions" aria-label="Account">
            <AuthControls onDone={close} />
          </div>

          <button
            type="button"
            className="cloak-navbar__menu-toggle"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="cloak-mobile-panel"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '✕' : '☰'}
          </button>
        </div>

        <div
          id="cloak-mobile-panel"
          className={open ? 'cloak-navbar__panel cloak-navbar__panel--open' : 'cloak-navbar__panel'}
          aria-hidden={!open}
        >
          <nav className="cloak-navbar__panel-nav" aria-label="Mobile navigation">
            {NAV_ITEMS.map(({ to, label, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => navLinkClass(isActive)} onClick={close}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="cloak-navbar__panel-actions">
            <AuthControls onDone={close} />
          </div>
        </div>
      </div>
    </header>
  )
}
