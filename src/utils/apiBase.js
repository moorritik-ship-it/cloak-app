function normalizeBase(base) {
  return String(base || '')
    .trim()
    .replace(/\/+$/, '')
}

/**
 * Returns the backend origin for API calls.
 *
 * - In dev: allow empty base so Vite proxy can handle `/api` + `/auth`.
 * - In prod: require VITE_API_BASE_URL so the deployed frontend calls your backend host.
 */
export function getApiBase() {
  const base = normalizeBase(import.meta.env.VITE_API_BASE_URL || '')
  if (base) return base

  // Vercel (and other static hosts) won't have Vite's dev proxy.
  // If this is missing in prod builds, API calls will hit the frontend origin and fail.
  if (!import.meta.env.DEV) {
    throw new Error('VITE_API_BASE_URL is not set (expected your backend URL).')
  }

  return ''
}

export function apiUrl(path) {
  const p = String(path || '')
  if (!p.startsWith('/')) {
    throw new Error(`apiUrl() expects a leading '/': got ${p}`)
  }
  return `${getApiBase()}${p}`
}

