/**
 * Supabase / Prisma database URL validation and safe logging.
 *
 * Transaction pooler (app runtime — set DATABASE_URL on Render):
 *   postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true
 *
 * Direct connection (migrations — set DIRECT_URL on Render):
 *   postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
 *   or legacy: postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
 */

const { PrismaClient } = require('@prisma/client')

/** @param {string} raw */
function tryParsePostgresUrl(raw) {
  if (!raw || !String(raw).trim()) return null
  try {
    const u = new URL(String(raw).trim())
    if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return null
    return {
      host: u.hostname,
      port: u.port || '5432',
      username: decodeURIComponent(u.username),
      password: u.password ? decodeURIComponent(u.password) : '',
      database: u.pathname.replace(/^\//, '') || 'postgres',
      search: u.search,
    }
  } catch {
    return null
  }
}

/**
 * Supabase pooler usernames look like postgres.<project-ref> (dot is part of the username).
 * @param {string} user
 */
function isSupabasePoolerUsername(user) {
  return /^postgres\.[a-z0-9]+$/i.test(String(user || ''))
}

/**
 * Legacy direct host db.<ref>.supabase.co
 * @param {string} host
 */
function isLegacySupabaseDbHost(host) {
  return /^db\.[a-z0-9]+\.supabase\.co$/i.test(String(host || ''))
}

/**
 * @param {string} host
 */
function isSupabasePoolerHost(host) {
  return /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i.test(String(host || ''))
}

/**
 * Build a correctly formatted Supabase transaction pooler URL.
 * Password is URL-encoded (required for $, @, #, etc.).
 */
function getPoolerHostname({ region = 'ap-south-1', poolerHost }) {
  const explicit = String(poolerHost || process.env.SUPABASE_POOLER_HOST || '').trim()
  if (explicit) return explicit
  const reg = String(region || 'ap-south-1').trim()
  return `aws-0-${reg}.pooler.supabase.com`
}

function buildSupabasePoolerUrl({ projectRef, password, region = 'ap-south-1', poolerHost }) {
  const ref = String(projectRef || '').trim()
  const pwd = encodeURIComponent(String(password || ''))
  if (!ref || !password) {
    throw new Error('projectRef and password are required to build a Supabase pooler URL')
  }
  const host = getPoolerHostname({ region, poolerHost })
  return `postgresql://postgres.${ref}:${pwd}@${host}:6543/postgres?pgbouncer=true`
}

/**
 * Build Supabase session-mode pooler URL (port 5432) for DIRECT_URL / migrations.
 */
function buildSupabaseDirectUrl({ projectRef, password, region = 'ap-south-1', poolerHost }) {
  const ref = String(projectRef || '').trim()
  const pwd = encodeURIComponent(String(password || ''))
  const host = getPoolerHostname({ region, poolerHost })
  return `postgresql://postgres.${ref}:${pwd}@${host}:5432/postgres`
}

/**
 * Prefer DATABASE_URL; if invalid, build from SUPABASE_* parts when set.
 */
function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()
  if (fromEnv) {
    const parsed = tryParsePostgresUrl(fromEnv)
    if (!parsed) {
      throw new Error('DATABASE_URL is not a valid postgresql:// URL')
    }
    const issues = validatePoolerUrl(parsed, 'DATABASE_URL', fromEnv)
    if (issues.length > 0) {
      throw new Error(
        `DATABASE_URL is misconfigured (${issues.join('; ')}). Use the Supabase transaction pooler: postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true`,
      )
    }
    return fromEnv
  }

  const ref = process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID
  const pwd = process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_PASSWORD
  const region = process.env.SUPABASE_REGION || 'ap-south-1'
  if (ref && pwd) {
    console.log('[database] Building DATABASE_URL from SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD')
    return buildSupabasePoolerUrl({ projectRef: ref, password: pwd, region })
  }

  throw new Error(
    'DATABASE_URL is missing or invalid. On Render set DATABASE_URL to your Supabase transaction pooler URL, e.g. postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true (URL-encode special characters in the password). Or set SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD + SUPABASE_REGION.',
  )
}

function resolveDirectUrl() {
  const fromEnv = process.env.DIRECT_URL && String(process.env.DIRECT_URL).trim()
  if (fromEnv) return fromEnv

  const ref = process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID
  const pwd = process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_PASSWORD
  const region = process.env.SUPABASE_REGION || 'ap-south-1'
  if (ref && pwd) {
    return buildSupabaseDirectUrl({ projectRef: ref, password: pwd, region })
  }

  return resolveDatabaseUrl()
}

/**
 * @param {ReturnType<typeof tryParsePostgresUrl>} parsed
 * @param {string} label
 * @param {string} [rawUrl]
 */
function validatePoolerUrl(parsed, label, rawUrl = '') {
  const issues = []
  if (!parsed) return ['Could not parse URL']

  if (!isSupabasePoolerUsername(parsed.username)) {
    if (parsed.username === 'postgres') {
      issues.push(
        `username is "${parsed.username}" but Supabase pooler requires postgres.<project-ref> (e.g. postgres.woumhfvlifirgbesizkw)`,
      )
    } else {
      issues.push('username should be postgres.<project-ref> for Supabase pooler')
    }
  }

  if (isLegacySupabaseDbHost(parsed.host) && String(parsed.port) === '6543') {
    issues.push(
      `host "${parsed.host}" with port 6543 is wrong — use aws-0-<region>.pooler.supabase.com:6543 for the pooler`,
    )
  }

  if (
    label === 'DATABASE_URL' &&
    !isSupabasePoolerHost(parsed.host) &&
    !isLegacySupabaseDbHost(parsed.host) &&
    parsed.port === '6543'
  ) {
    issues.push(
      `host "${parsed.host}" does not look like a Supabase pooler — copy the exact hostname from Supabase → Settings → Database (may be aws-1-… not aws-0-…)`,
    )
  }

  let rawPassword = ''
  try {
    rawPassword = new URL(String(rawUrl || '').trim()).password
  } catch {
    rawPassword = ''
  }
  if (rawPassword && /[$#@]/.test(rawPassword)) {
    issues.push(
      'password contains unencoded special characters ($, #, @) in the URL — URL-encode them (e.g. $ → %24)',
    )
  }

  if (label === 'DATABASE_URL' && parsed.port !== '6543' && parsed.port !== '5432') {
    issues.push(`unexpected port ${parsed.port} for pooler (expected 6543 transaction or 5432 session)`)
  }

  return issues
}

/**
 * Throws if database env cannot be resolved.
 */
function assertDatabaseEnv() {
  resolveDatabaseUrl()
  resolveDirectUrl()
}

/**
 * Safe one-line summary for logs (no password).
 */
function logDatabaseEnvDiagnostics() {
  const url = resolveDatabaseUrl()
  const direct = resolveDirectUrl()
  const p = tryParsePostgresUrl(url)
  const d = tryParsePostgresUrl(direct)
  if (p) {
    console.log('[database] DATABASE_URL', {
      host: p.host,
      port: p.port,
      user: p.username,
      database: p.database,
      pgbouncer: p.search.includes('pgbouncer'),
    })
  }
  if (d) {
    console.log('[database] DIRECT_URL', {
      host: d.host,
      port: d.port,
      user: d.username,
      database: d.database,
    })
  }
}

/**
 * @returns {import('@prisma/client').PrismaClient}
 */
function createPrismaClient() {
  const url = resolveDatabaseUrl()
  const directUrl = resolveDirectUrl()

  process.env.DATABASE_URL = url
  process.env.DIRECT_URL = directUrl

  return new PrismaClient({
    datasources: {
      db: { url },
    },
  })
}

module.exports = {
  tryParsePostgresUrl,
  buildSupabasePoolerUrl,
  buildSupabaseDirectUrl,
  resolveDatabaseUrl,
  resolveDirectUrl,
  assertDatabaseEnv,
  logDatabaseEnvDiagnostics,
  createPrismaClient,
  validatePoolerUrl,
  isSupabasePoolerUsername,
}
