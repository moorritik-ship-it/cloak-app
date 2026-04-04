/**
 * Login email rules — keep in sync with backend/server.js (OTP_EMAIL_REGEX + whitelist).
 * Whitelisted Gmail test accounts bypass the college .ac.in pattern.
 */

export const COLLEGE_OTP_EMAIL_REGEX = /^[a-z]+[a-z]\.[a-z]{2,4}\.[0-9]{2}@[a-z]+\.ac\.in$/

/** Exact test accounts (lowercase ASCII after normalization). */
export const WHITELIST_TEST_EMAILS = new Set(['moorritik@gmail.com', 'moorritik6@gmail.com'])

/**
 * Normalize pasted / autofill input so whitelist lookups work in all browsers (incognito, IME, etc.).
 * Handles fullwidth @, NBSP, zero-width chars, Unicode normalization.
 */
export function normalizeEmailForLogin(email) {
  if (email == null) return ''
  return String(email)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\uFF20/g, '@')
    .replace(/\uFF0E/g, '.')
    .trim()
    .toLowerCase()
}

/** Regex backup for whitelist (same addresses as WHITELIST_TEST_EMAILS). */
const WHITELIST_TEST_EMAILS_REGEX = /^(moorritik@gmail\.com|moorritik6@gmail\.com)$/

/**
 * @param {string} email
 * @returns {boolean}
 */
export function isLoginEmailAllowed(email) {
  const e = normalizeEmailForLogin(email)
  if (!e) return false
  if (WHITELIST_TEST_EMAILS_REGEX.test(e)) return true
  if (WHITELIST_TEST_EMAILS.has(e)) return true
  return COLLEGE_OTP_EMAIL_REGEX.test(e)
}
