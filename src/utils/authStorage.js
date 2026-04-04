/**
 * Auth session in sessionStorage so each browser tab can be logged in as a different user.
 * (localStorage is shared across tabs on the same origin.)
 * One-time migration: if session is empty but legacy localStorage keys exist, copy into this tab's session.
 */

const ACCESS = 'cloak_access_token'
const PROFILE = 'cloak_user_profile'

function migrateFromLocalStorageOnce() {
  if (typeof window === 'undefined') return
  if (sessionStorage.getItem(ACCESS)) return
  const legacyToken = localStorage.getItem(ACCESS)
  if (!legacyToken) return
  sessionStorage.setItem(ACCESS, legacyToken)
  const legacyProfile = localStorage.getItem(PROFILE)
  if (legacyProfile) sessionStorage.setItem(PROFILE, legacyProfile)
}

/**
 * @returns {string | null}
 */
export function getAccessToken() {
  if (typeof window === 'undefined') return null
  migrateFromLocalStorageOnce()
  return sessionStorage.getItem(ACCESS)
}

/**
 * @returns {string | null} JSON string of user object
 */
export function getUserProfileJson() {
  if (typeof window === 'undefined') return null
  migrateFromLocalStorageOnce()
  return sessionStorage.getItem(PROFILE)
}

/**
 * @param {string} accessToken
 * @param {object} user — serialized to JSON for PROFILE
 */
export function setAuthSession(accessToken, user) {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ACCESS)
  localStorage.removeItem(PROFILE)
  sessionStorage.setItem(ACCESS, accessToken)
  sessionStorage.setItem(PROFILE, JSON.stringify(user))
}

/** Clear auth in this tab and legacy localStorage keys. */
export function clearAuthSession() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(ACCESS)
  sessionStorage.removeItem(PROFILE)
  localStorage.removeItem(ACCESS)
  localStorage.removeItem(PROFILE)
}

/** Merge fields into stored user profile (e.g. after CloakScore update). */
export function mergeUserProfile(updates) {
  if (typeof window === 'undefined' || !updates || typeof updates !== 'object') return
  migrateFromLocalStorageOnce()
  const raw = sessionStorage.getItem(PROFILE)
  if (!raw) return
  try {
    const j = JSON.parse(raw)
    sessionStorage.setItem(PROFILE, JSON.stringify({ ...j, ...updates }))
  } catch {
    // ignore
  }
}
