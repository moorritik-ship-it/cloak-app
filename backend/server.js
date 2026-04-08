const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const dotenv = require('dotenv')
const http = require('http')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { Server } = require('socket.io')
const { PrismaClient, Prisma } = require('@prisma/client')
const { Redis } = require('@upstash/redis')
const { createMatchingService } = require('./matchingService')
const { createCloakScoreQueue } = require('./cloakScoreQueue')

dotenv.config()

/**
 * CORS + credentials (cookies / Authorization): Allow-Origin must echo the request Origin, never *.
 *
 * - No Origin header (same-origin, curl, etc.): allowed.
 * - Local dev: any http(s) origin whose host is localhost / 127.0.0.1 / ::1 (any port, e.g. Vite 5173).
 * - Production: set CLIENT_ORIGIN to your deployed frontend URL(s), comma-separated, no trailing slash:
 *     CLIENT_ORIGIN=https://my-app.vercel.app
 *     CLIENT_ORIGIN=https://my-app.vercel.app,https://www.example.com
 *   Optional: include the literal token *.vercel.app to allow any https://*.vercel.app (preview + prod).
 */
function isLocalhostOrigin(origin) {
  if (!origin) return false
  try {
    const { hostname } = new URL(origin)
    const h = hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

function normalizeCorsOrigin(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

function parseClientOriginEntries() {
  const raw = process.env.CLIENT_ORIGIN
  if (!raw || !String(raw).trim()) return []
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isHttpsVercelAppOrigin(origin) {
  try {
    const u = new URL(origin)
    return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.vercel.app')
  } catch {
    return false
  }
}

const CLIENT_ORIGIN_ENTRIES = parseClientOriginEntries()
if (CLIENT_ORIGIN_ENTRIES.length) {
  console.log('[cors] CLIENT_ORIGIN allow-list:', CLIENT_ORIGIN_ENTRIES.join(', '))
} else {
  console.warn(
    '[cors] CLIENT_ORIGIN is unset — non-localhost browsers need CLIENT_ORIGIN (e.g. https://your-app.vercel.app)',
  )
}

function corsAllowOrigin(origin, callback) {
  if (!origin) {
    return callback(null, true)
  }

  if (isLocalhostOrigin(origin)) {
    return callback(null, true)
  }

  const requestOrigin = normalizeCorsOrigin(origin)

  for (const entry of CLIENT_ORIGIN_ENTRIES) {
    if (entry === '*.vercel.app') {
      if (isHttpsVercelAppOrigin(origin)) {
        return callback(null, true)
      }
      continue
    }
    if (normalizeCorsOrigin(entry) === requestOrigin) {
      return callback(null, true)
    }
  }

  return callback(new Error('Not allowed by CORS'))
}

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: corsAllowOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  },
})

const prisma = new PrismaClient()
const PORT = Number.parseInt(process.env.PORT || '', 10) || 4000

let upstashRedis = null
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  upstashRedis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
} else {
  console.warn('[matching] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing — queue disabled until configured')
}

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret'
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret'
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '')
  .replace(/^['"]|['"]$/g, '')
  .trim()
const TEST_COLLEGE_DOMAIN = (process.env.TEST_COLLEGE_DOMAIN || 'nitj.ac.in').trim().toLowerCase()
const DEBUG_CREATE_ADMIN = process.env.DEBUG_CREATE_ADMIN === '1'

/**
 * Gmail(s) allowed to bypass college .ac.in regex for dev/testing.
 * Env: WHITELIST_TEST_EMAILS=comma,separated  OR  legacy WHITELIST_TEST_EMAIL=single
 * Core test accounts are always included so .env never accidentally drops moorritik6.
 * (Keep in sync with react-video-app/src/utils/loginEmail.js WHITELIST_TEST_EMAILS.)
 */
const CORE_WHITELIST_TEST_EMAILS = ['moorritik@gmail.com', 'moorritik6@gmail.com']

/**
 * Match frontend src/utils/loginEmail.js — same normalization before whitelist / DB lookups.
 */
function normalizeEmailForAuth(email) {
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

function parseWhitelistTestEmails() {
  const out = new Set(CORE_WHITELIST_TEST_EMAILS.map((e) => e.toLowerCase()))

  const multi = process.env.WHITELIST_TEST_EMAILS
  if (multi && String(multi).trim()) {
    String(multi)
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .forEach((e) => out.add(e))
    return out
  }

  const single = process.env.WHITELIST_TEST_EMAIL
  if (single && String(single).trim()) {
    out.add(String(single).trim().toLowerCase())
  }
  return out
}

const WHITELIST_TEST_EMAILS = parseWhitelistTestEmails()

function isWhitelistedTestEmail(email) {
  const e = normalizeEmailForAuth(email)
  if (!e) return false
  return WHITELIST_TEST_EMAILS.has(e)
}

const _whitelistAll = [...WHITELIST_TEST_EMAILS].sort()
console.log('[auth] CORE_WHITELIST_TEST_EMAILS (array):', JSON.stringify(CORE_WHITELIST_TEST_EMAILS))
console.log('[auth] Complete whitelist (all emails, sorted):', JSON.stringify(_whitelistAll))
console.log('[auth] Whitelist email count:', _whitelistAll.length)

if (RESEND_API_KEY) {
  // Print only a short prefix so we can verify dotenv loaded the key.
  console.log(`RESEND_API_KEY prefix: ${RESEND_API_KEY.slice(0, 6)}`)
} else {
  console.log('RESEND_API_KEY is missing from environment')
}
const OTP_EMAIL_REGEX = /^[a-z]+[a-z]\.[a-z]{2,4}\.[0-9]{2}@[a-z]+\.ac\.in$/
const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

const cloakQueue = createCloakScoreQueue({ prisma })

const matching = createMatchingService({
  io,
  prisma,
  redis: upstashRedis,
  accessTokenSecret: ACCESS_TOKEN_SECRET,
  cloakQueue,
})

app.use(helmet())
app.use(
  cors({
    origin: corsAllowOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
    optionsSuccessStatus: 204,
  }),
)
app.use(express.json())
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  }),
)

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function getUserIdFromBearer(req) {
  const auth = String(req.headers.authorization || '').trim()
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  try {
    const payload = jwt.verify(m[1], ACCESS_TOKEN_SECRET)
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

const IST_TZ = 'Asia/Kolkata'
const LEADERBOARD_CACHE_SECONDS = 15 * 60

function istYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

function istWeekdayShort(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, weekday: 'short' }).format(date)
}

function istStartOfDay(date = new Date()) {
  const ymd = istYmd(date)
  return new Date(`${ymd}T00:00:00+05:30`)
}

function istStartOfWeekMonday(date = new Date()) {
  const startToday = istStartOfDay(date)
  const w = istWeekdayShort(date)
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dow = map[w] ?? 0
  const delta = (dow + 6) % 7 // days since Monday
  const out = new Date(startToday)
  out.setDate(out.getDate() - delta)
  return out
}

function istStartOfMonth(date = new Date()) {
  const ymd = istYmd(date)
  const [y, m] = ymd.split('-')
  return new Date(`${y}-${m}-01T00:00:00+05:30`)
}

function periodWindowIst(period, now = new Date()) {
  if (period === 'today') {
    const start = istStartOfDay(now)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return { start, end }
  }
  if (period === 'week') {
    const start = istStartOfWeekMonday(now)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    return { start, end }
  }
  if (period === 'month') {
    const start = istStartOfMonth(now)
    const end = new Date(start)
    end.setMonth(end.getMonth() + 1)
    return { start, end }
  }
  return { start: null, end: null } // all-time
}

async function redisGetJson(key) {
  if (!upstashRedis) return null
  try {
    const raw = await upstashRedis.get(key)
    if (!raw) return null
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw
  } catch {
    return null
  }
}

async function redisSetJson(key, value, exSeconds) {
  if (!upstashRedis) return false
  try {
    await upstashRedis.set(key, JSON.stringify(value), { ex: exSeconds })
    return true
  } catch {
    return false
  }
}

const { registerWalletApi } = require('./walletApi')
registerWalletApi(app, { prisma, getUserIdFromBearer })

const { registerReportApi } = require('./reportApi')
registerReportApi(app, { prisma, getUserIdFromBearer, matching })

const { registerBlockApi } = require('./blockApi')
registerBlockApi(app, { prisma, getUserIdFromBearer })

const { registerAdminApi } = require('./adminApi')
registerAdminApi(app, { prisma, getUserIdFromBearer })

app.post('/api/payments/razorpay/verify-extension', async (req, res) => {
  const userId = getUserIdFromBearer(req)
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  try {
    const { room_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
    if (!room_id || !razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ ok: false, message: 'Missing payment fields.' })
    }
    const result = await matching.verifyExtensionPayment({
      userId,
      roomId: room_id,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature: typeof razorpay_signature === 'string' ? razorpay_signature : '',
    })
    return res.json(result)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e?.message || 'Payment verification failed.' })
  }
})

app.post('/api/payments/razorpay/queue-unlock-order', async (req, res) => {
  const userId = getUserIdFromBearer(req)
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  try {
    const out = await matching.createQueueUnlockOrder(userId)
    return res.json({ ok: true, ...out })
  } catch (e) {
    return res.status(400).json({ ok: false, message: e?.message || 'Could not create order.' })
  }
})

app.post('/api/payments/razorpay/verify-queue-unlock', async (req, res) => {
  const userId = getUserIdFromBearer(req)
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ ok: false, message: 'Missing payment fields.' })
    }
    const result = await matching.verifyQueueUnlockPayment({
      userId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature: typeof razorpay_signature === 'string' ? razorpay_signature : '',
    })
    return res.json(result)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e?.message || 'Payment verification failed.' })
  }
})

function generateNumericOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/**
 * Resend sandbox often allows only one test inbox. Moorritik6 logs in as a separate user but
 * receives the OTP at the same mailbox as moorritik@gmail.com (RESEND_TEST_TO_EMAIL or default).
 */
const MOORRITIK6_TEST_EMAIL = 'moorritik6@gmail.com'

function getOtpResendRecipients(requestedLoginEmail) {
  const e = normalizeEmailForAuth(requestedLoginEmail)
  const testInbox = (process.env.RESEND_TEST_TO_EMAIL || 'moorritik@gmail.com').trim().toLowerCase()
  if (e === MOORRITIK6_TEST_EMAIL) {
    return { to: [testInbox], loginLabel: e }
  }
  if (isWhitelistedTestEmail(requestedLoginEmail)) {
    return { to: [e], loginLabel: null }
  }
  return { to: [testInbox], loginLabel: null }
}

async function sendOtpWithResend(email, otp) {
  const rawFrom = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
  const fromMatch = rawFrom.match(/<([^>]+)>/)
  const fromEmail = fromMatch ? fromMatch[1] : rawFrom
  const { to, loginLabel } = getOtpResendRecipients(email)

  const loginHint =
    loginLabel != null
      ? `\n\n(This OTP is for signing in as ${loginLabel} — delivered to the shared test inbox.)`
      : ''
  const loginHintHtml =
    loginLabel != null
      ? `<p style="font-size:0.9rem;opacity:0.85">Signing in as <strong>${loginLabel}</strong> (OTP sent to your Resend test inbox).</p>`
      : ''

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CLOAK-OTP',
    },
    body: JSON.stringify({
      from: fromEmail,
      to,
      subject: 'Your CLOAK OTP',
      text: `Your CLOAK verification code is ${otp}. This code expires in 5 minutes.${loginHint}`,
      html: `<p>Your CLOAK verification code is <strong>${otp}</strong>.</p><p>This code expires in 5 minutes.</p>${loginHintHtml}`,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    let errorJson = null
    try {
      errorJson = JSON.parse(errorBody)
    } catch {
      // ignore: keep raw text
    }

    console.error('Resend request failed')
    console.error('Resend status:', response.status)
    console.error('Resend statusText:', response.statusText)
    console.error('Resend raw body:', errorBody)
    if (errorJson) {
      console.error('Resend parsed error:', errorJson)
    }

    const resendMessage = errorJson?.message || errorBody
    throw new Error(resendMessage)
  }
}

/**
 * Fast health check for load balancers.
 * Must return immediately (no DB/Redis dependency) so platforms like Render don't time out startup.
 */
app.get('/health', (req, res) => {
  return res.status(200).json({ status: 'ok' })
})

/** Optional deeper checks */
app.get('/health/db', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return res.status(200).json({ db: 'ok' })
  } catch (error) {
    return res.status(503).json({ db: 'error' })
  }
})

app.get('/leaderboard/top', async (req, res) => {
  try {
    const topUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { cloakScore: 'desc' },
      select: {
        id: true,
        preferredUsername: true,
        cloakScore: true,
      },
    })

    return res.status(200).json({
      users: topUsers.map((u, idx) => ({
        rank: idx + 1,
        id: u.id,
        username: u.preferredUsername ?? 'Anonymous',
        cloakScore: u.cloakScore,
      })),
    })
  } catch (error) {
    console.error('leaderboard/top error:', error)
    return res.status(500).json({ message: 'Failed to load leaderboard.' })
  }
})

/** College-scoped dashboard: sessions today + top 5 users at same college */
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' })
    }
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { collegeId: true },
    })
    if (!me?.collegeId) {
      return res.status(404).json({ message: 'User not found.' })
    }
    const collegeId = me.collegeId

    const startOfDay = istStartOfDay()
    const endOfDay = new Date(startOfDay)
    endOfDay.setDate(endOfDay.getDate() + 1)

    const cacheKey = `dash:summary:${collegeId}:${istYmd()}`
    const cached = await redisGetJson(cacheKey)
    if (cached) {
      return res.status(200).json({ ...cached, cached: true })
    }

    const [sessionsToday, topUsers] = await Promise.all([
      prisma.session.count({
        where: {
          collegeId,
          startedAt: {
            gte: startOfDay,
            lt: endOfDay,
          },
        },
      }),
      prisma.user.findMany({
        where: { collegeId },
        take: 5,
        orderBy: { cloakScore: 'desc' },
        select: {
          id: true,
          preferredUsername: true,
          cloakScore: true,
        },
      }),
    ])

    const payload = {
      sessionsToday,
      leaderboard: topUsers.map((u, idx) => ({
        rank: idx + 1,
        id: u.id,
        username: u.preferredUsername ?? 'Student',
        cloakScore: u.cloakScore,
      })),
    }
    await redisSetJson(cacheKey, payload, LEADERBOARD_CACHE_SECONDS)
    return res.status(200).json({ ...payload, cached: false })
  } catch (error) {
    console.error('dashboard/summary error:', error)
    return res.status(500).json({ message: 'Failed to load dashboard summary.' })
  }
})

/**
 * College leaderboard (never cross-college). Tabs: today/week/month/all.
 * Returns top 10 + always includes the authenticated user's rank row.
 */
app.get('/api/leaderboard/college', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

    const rawPeriod = String(req.query.period || '').trim().toLowerCase()
    const period =
      rawPeriod === 'today' || rawPeriod === 'week' || rawPeriod === 'month' || rawPeriod === 'all'
        ? rawPeriod
        : 'today'

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, collegeId: true },
    })
    if (!me?.collegeId) return res.status(404).json({ message: 'User not found.' })

    const { start, end } = periodWindowIst(period === 'all' ? 'all' : period)
    const startIso = start ? start.toISOString() : null
    const endIso = end ? end.toISOString() : null

    const cacheKey = `lb:college:${me.collegeId}:${period}:${startIso || 'all'}`
    const cached = await redisGetJson(cacheKey)
    if (cached) {
      return res.status(200).json({ ...cached, cached: true })
    }

    // Note: uses raw SQL for efficiency + correct rank windowing.
    // Score for today/week/month = SUM(ledger.delta) in window; score for all = users.cloak_score.
    const scoreExpr =
      period === 'all' ? Prisma.sql`bu.cloak_score` : Prisma.sql`COALESCE(SUM(l.delta), 0)`
    const ledgerJoin =
      period === 'all'
        ? Prisma.sql``
        : Prisma.sql`
          LEFT JOIN cloak_score_ledger l
            ON l.user_id = bu.id
           AND l.created_at >= ${start}
           AND l.created_at < ${end}
        `
    const sessionWindow =
      start && end
        ? Prisma.sql`AND s.started_at >= ${start} AND s.started_at < ${end}`
        : Prisma.sql``

    const query = Prisma.sql`
      WITH base_users AS (
        SELECT u.id, u.preferred_username, u.leaderboard_anonymous, u.cloak_score
        FROM users u
        WHERE u.college_id = ${me.collegeId}
      ),
      scores AS (
        SELECT
          bu.id,
          bu.preferred_username,
          bu.leaderboard_anonymous,
          ${scoreExpr} AS score
        FROM base_users bu
        ${ledgerJoin}
        GROUP BY bu.id, bu.preferred_username, bu.leaderboard_anonymous, bu.cloak_score
      ),
      sessions AS (
        SELECT
          bu.id,
          COALESCE(COUNT(s.id), 0)::int AS sessions_count
        FROM base_users bu
        LEFT JOIN sessions s
          ON (s.user1_id = bu.id OR s.user2_id = bu.id)
          ${sessionWindow}
        GROUP BY bu.id
      ),
      combined AS (
        SELECT
          sc.id,
          sc.preferred_username,
          sc.leaderboard_anonymous,
          sc.score::int AS score,
          se.sessions_count
        FROM scores sc
        JOIN sessions se ON se.id = sc.id
      ),
      ranked AS (
        SELECT
          *,
          RANK() OVER (ORDER BY score DESC, id ASC)::int AS rank
        FROM combined
      )
      SELECT id, preferred_username, leaderboard_anonymous, score, sessions_count, rank
      FROM ranked
      WHERE rank <= 10 OR id = ${me.id}
      ORDER BY rank ASC, id ASC
    `

    const rows = await prisma.$queryRaw(query)

    const entries = []
    let meRow = null
    for (const r of rows || []) {
      const isMe = r.id === me.id
      const username =
        r.leaderboard_anonymous === true ? 'Anonymous' : r.preferred_username || 'Student'
      const row = {
        rank: Number(r.rank) || 0,
        id: r.id,
        username,
        cloakScore: Number(r.score) || 0,
        sessions: Number(r.sessions_count) || 0,
        isMe,
      }
      if (isMe) meRow = row
      if ((Number(r.rank) || 0) <= 10) entries.push(row)
    }

    const payload = {
      period,
      entries,
      me: meRow,
      updatedAt: new Date().toISOString(),
    }
    await redisSetJson(cacheKey, payload, LEADERBOARD_CACHE_SECONDS)
    return res.status(200).json({ ...payload, cached: false })
  } catch (error) {
    console.error('leaderboard/college error:', error)
    return res.status(500).json({ message: 'Failed to load leaderboard.' })
  }
})

/** Toggle current user's anonymity on college leaderboards */
app.post('/api/leaderboard/anonymous', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) return res.status(401).json({ message: 'Unauthorized.' })
    const { anonymous } = req.body || {}
    const next = Boolean(anonymous)
    const user = await prisma.user.update({
      where: { id: userId },
      data: { leaderboardAnonymous: next },
      select: { id: true, leaderboardAnonymous: true },
    })
    return res.status(200).json({ ok: true, leaderboardAnonymous: user.leaderboardAnonymous })
  } catch (error) {
    console.error('leaderboard/anonymous error:', error)
    return res.status(500).json({ message: 'Failed to update setting.' })
  }
})

/** Persist that the authenticated user read community guidelines before connecting */
/** Authenticated user snapshot (cloak score, streak) */
app.get('/api/me', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' })
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        collegeId: true,
        preferredUsername: true,
        leaderboardAnonymous: true,
        cloakScore: true,
        cloakStreakDays: true,
        lastDailyRewardIstDate: true,
        walletBalance: true,
        walletPinHash: true,
        isAdmin: true,
        themePreference: true,
      },
    })
    if (!user) {
      return res.status(404).json({ message: 'User not found.' })
    }
    const { walletPinHash, ...rest } = user
    return res.status(200).json({
      user: {
        ...rest,
        walletBalance: user.walletBalance?.toString(),
        hasWalletPin: Boolean(walletPinHash),
      },
    })
  } catch (error) {
    console.error('/api/me error:', error)
    return res.status(500).json({ message: 'Failed to load profile.' })
  }
})

/** Queue daily login reward (5 + streak bonus); idempotent per IST calendar day */
app.post('/api/cloak/daily-login', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' })
    }
    const { istCalendarDateString } = require('./cloakScoreProcessor')
    const istToday = istCalendarDateString()
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastDailyRewardIstDate: true, cloakScore: true },
    })
    if (!user) {
      return res.status(404).json({ message: 'User not found.' })
    }
    if (user.lastDailyRewardIstDate === istToday) {
      return res.status(200).json({
        alreadyClaimed: true,
        cloakScore: user.cloakScore,
        istDate: istToday,
      })
    }
    cloakQueue.enqueueDailyLogin(userId)
    return res.status(202).json({
      queued: true,
      message: 'Daily CloakScore reward is processing.',
      istDate: istToday,
    })
  } catch (error) {
    console.error('cloak daily-login error:', error)
    return res.status(500).json({ message: 'Failed to queue daily reward.' })
  }
})

app.post('/api/cloak/guidelines/acknowledge', async (req, res) => {
  try {
    const userId = getUserIdFromBearer(req)
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' })
    }

    const acknowledgedAt = new Date()

    const row = await prisma.communityGuidelinesAcknowledgment.create({
      data: {
        userId,
        acknowledgedAt,
      },
      select: {
        id: true,
        acknowledgedAt: true,
      },
    })

    return res.status(201).json({
      id: row.id,
      acknowledgedAt: row.acknowledgedAt.toISOString(),
    })
  } catch (error) {
    console.error('guidelines/acknowledge error:', error)
    return res.status(500).json({ message: 'Failed to save acknowledgment.' })
  }
})

app.post('/auth/request-otp', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const emailInput = normalizeEmailForAuth(body.email)
    if (!emailInput) {
      return res.status(400).json({
        message: 'Invalid college email format.',
      })
    }

    if (!OTP_EMAIL_REGEX.test(emailInput) && !isWhitelistedTestEmail(emailInput)) {
      return res.status(400).json({
        message: 'Invalid college email format.',
      })
    }

    const domain = isWhitelistedTestEmail(emailInput) ? TEST_COLLEGE_DOMAIN : emailInput.split('@')[1]
    const college = await prisma.college.findFirst({
      where: { domain, isActive: true },
    })

    if (!college) {
      return res.status(400).json({
        message: isWhitelistedTestEmail(emailInput)
          ? 'Test college not configured/active.'
          : 'College not registered or inactive.',
      })
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const recentRequestCount = await prisma.otpRequestLog.count({
      where: {
        email: emailInput,
        createdAt: {
          gte: oneHourAgo,
        },
      },
    })

    if (recentRequestCount >= 3) {
      return res.status(429).json({
        message: 'Maximum OTP requests reached. Try again in an hour.',
      })
    }

    const user = await prisma.user.findUnique({
      where: { email: emailInput },
      select: { id: true },
    })

    const otp = generateNumericOtp()
    const otpHash = hashValue(otp)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    /** Persist OTP before sending email so verification never looks up a missing row if DB fails after Resend. */
    const [createdOtp, requestLog] = await prisma.$transaction([
      prisma.otpCode.create({
        data: {
          email: emailInput,
          userId: user?.id,
          otpHash,
          expiresAt,
        },
      }),
      prisma.otpRequestLog.create({
        data: {
          email: emailInput,
          userId: user?.id,
        },
      }),
    ])

    try {
      await sendOtpWithResend(emailInput, otp)
    } catch (sendErr) {
      await prisma.otpCode.delete({ where: { id: createdOtp.id } }).catch(() => {})
      await prisma.otpRequestLog.delete({ where: { id: requestLog.id } }).catch(() => {})
      throw sendErr
    }

    return res.status(200).json({ message: 'OTP sent successfully.' })
  } catch (error) {
    console.error('request-otp error:', error)
    return res.status(500).json({ message: error?.message || 'Failed to send OTP.' })
  }
})

app.post('/auth/verify-otp', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const emailInput = normalizeEmailForAuth(body.email)
    const otpInput = String(body.otp ?? '')
      .trim()
      .replace(/\s+/g, '')

    if ((!OTP_EMAIL_REGEX.test(emailInput) && !isWhitelistedTestEmail(emailInput)) || !/^\d{6}$/.test(otpInput)) {
      return res.status(400).json({ message: 'Invalid OTP verification payload.' })
    }

    const otpHash = hashValue(otpInput)
    const now = new Date()
    // Exact match on normalized email (same string stored in request-otp). Avoids Prisma `mode: insensitive`
    // issues on some PostgreSQL / driver setups that can throw at query time.
    let otpRecord = await prisma.otpCode.findFirst({
      where: {
        email: emailInput,
        otpHash,
        consumedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    // Legacy rows may differ only by casing; hash + expiry already pin the row.
    if (!otpRecord) {
      const candidates = await prisma.otpCode.findMany({
        where: {
          otpHash,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      })
      otpRecord =
        candidates.find((r) => r.email.toLowerCase() === emailInput.toLowerCase()) || null
    }

    if (!otpRecord) {
      return res.status(400).json({ message: 'OTP is invalid or expired.' })
    }

    const domain = isWhitelistedTestEmail(emailInput) ? TEST_COLLEGE_DOMAIN : emailInput.split('@')[1]
    const college = await prisma.college.findFirst({
      where: { domain, isActive: true },
    })

    if (!college) {
      return res.status(400).json({
        message: isWhitelistedTestEmail(emailInput)
          ? 'Test college not configured/active.'
          : 'College not registered or inactive.',
      })
    }

    let user = await prisma.user.findUnique({
      where: {
        email: emailInput,
      },
    })

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            email: emailInput,
            collegeId: college.id,
          },
        })
      } catch (createErr) {
        // Parallel verify requests can race on unique email — retry fetch
        if (createErr?.code === 'P2002') {
          user = await prisma.user.findUnique({ where: { email: emailInput } })
        }
        if (!user) {
          throw createErr
        }
      }
    }

    if (DEBUG_CREATE_ADMIN) {
      const admins = String(process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
      if (admins.includes(emailInput) && !user.isAdmin) {
        try {
          user = await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } })
        } catch {
          // ignore
        }
      }
    }

    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { consumedAt: new Date(), userId: user.id },
    })

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, collegeId: user.collegeId, isAdmin: Boolean(user.isAdmin) },
      ACCESS_TOKEN_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL },
    )
    const rawRefreshToken = crypto.randomBytes(48).toString('hex')
    const refreshTokenHash = hashValue(rawRefreshToken)
    const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt: refreshTokenExpiresAt,
      },
    })

    res.cookie('cloak_refresh_token', rawRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      path: '/',
    })

    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        collegeId: true,
        preferredUsername: true,
        cloakScore: true,
        walletBalance: true,
        themePreference: true,
        walletPinHash: true,
        isAdmin: true,
      },
    })
    const u = fresh || user

    return res.status(200).json({
      accessToken,
      user: {
        id: u.id,
        email: u.email,
        collegeId: u.collegeId,
        preferredUsername: u.preferredUsername,
        cloakScore: u.cloakScore,
        walletBalance: u.walletBalance?.toString(),
        themePreference: u.themePreference,
        hasWalletPin: Boolean(u.walletPinHash),
        isAdmin: Boolean(u.isAdmin),
      },
    })
  } catch (error) {
    const msg = error?.message || String(error)
    const code = error?.code
    const name = error?.name
    console.error('[verify-otp] FAILED', { name, code, message: msg, stack: error?.stack })
    if (error?.meta) {
      console.error('[verify-otp] prisma meta:', error.meta)
    }
    const payload = { message: 'Failed to verify OTP.' }
    if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_AUTH === '1') {
      payload.detail = msg
      if (code) payload.code = code
    }
    return res.status(500).json(payload)
  }
})

/** Verify Upstash REST API with Redis PING before accepting traffic */
async function verifyUpstashRedis() {
  if (!upstashRedis) return { ok: false, reason: 'not_configured' }
  try {
    const pong = await upstashRedis.ping()
    const ok = pong === 'PONG' || pong === true || String(pong).toUpperCase() === 'PONG'
    if (ok) return { ok: true, pong }
    return { ok: false, reason: 'unexpected_pong', pong }
  } catch (e) {
    return { ok: false, reason: 'request_failed', error: e?.message || String(e) }
  }
}

app.get('/health/redis', async (req, res) => {
  if (!upstashRedis) {
    return res.status(200).json({ redis: 'not_configured' })
  }
  const result = await verifyUpstashRedis()
  if (result.ok) {
    return res.status(200).json({ redis: 'ok', ping: result.pong })
  }
  return res.status(503).json({
    redis: 'error',
    reason: result.reason,
    message: result.error || result.pong || 'PING failed',
  })
})

const VIDEO_CHAT_MSG_TTL_MS = 24 * 60 * 60 * 1000

async function deleteExpiredVideoChatMessages() {
  try {
    const cutoff = new Date(Date.now() - VIDEO_CHAT_MSG_TTL_MS)
    const result = await prisma.videoChatMessage.deleteMany({
      where: { sentAt: { lt: cutoff } },
    })
    if (result.count > 0) {
      console.log(`[chat] deleted ${result.count} video chat message(s) older than 24h`)
    }
  } catch (e) {
    console.error('[chat] TTL cleanup failed:', e?.message || e)
  }
}

function startServer() {
  // Start listening immediately (don't block on DB/Redis).
  server.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`)

    // Background initialization after the server is already accepting traffic.
    setImmediate(() => {
      // Prisma connect (non-blocking)
      prisma
        .$connect()
        .then(() => {
          console.log('Prisma connected to PostgreSQL')
        })
        .catch((error) => {
          console.error('Prisma connection failed:', error?.message || error)
        })

      // Redis ping (non-blocking)
      if (upstashRedis) {
        verifyUpstashRedis()
          .then((result) => {
            if (result.ok) {
              console.log('[matching] Upstash Redis: PING OK — connection verified')
            } else {
              console.error(
                '[matching] Upstash Redis: PING failed —',
                result.reason,
                result.error || result.pong || '',
              )
            }
          })
          .catch((e) => {
            console.error('[matching] Upstash Redis: PING failed —', e?.message || e)
          })
      }

      // TTL cleanup loop (non-blocking)
      deleteExpiredVideoChatMessages().catch(() => {})
      setInterval(() => {
        deleteExpiredVideoChatMessages()
      }, 60 * 60 * 1000)
    })
  })
}

startServer()

process.on('SIGINT', async () => {
  await prisma.$disconnect()
  process.exit(0)
})
