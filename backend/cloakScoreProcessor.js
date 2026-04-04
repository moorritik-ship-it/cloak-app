/**
 * CloakScore award logic — invoked from Bull queue (or setImmediate fallback).
 */

const MAX_MINUTE_POINTS = 7
const FULL_SEVEN_BONUS = 20
const INTEGRITY_BONUS = 10
const MAX_ENGAGED_SECONDS = 7 * 60

/**
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD in Asia/Kolkata
 */
function istCalendarDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

/**
 * @param {string} ymd
 * @param {number} deltaDays
 */
function addDaysIstYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + deltaDays)
  return istCalendarDateString(t)
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} sessionId
 */
async function processSessionRewardsJob(prisma, sessionId) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  })
  if (!session || session.cloakRewardsProcessedAt) return

  const reportCount = await prisma.report.count({
    where: { sessionId },
  })
  const noReports = reportCount === 0

  const u1 = session.user1Id
  const u2 = session.user2Id
  const e1 = Math.min(MAX_ENGAGED_SECONDS, Math.max(0, session.user1EngagedSeconds ?? 0))
  const e2 = Math.min(MAX_ENGAGED_SECONDS, Math.max(0, session.user2EngagedSeconds ?? 0))

  /**
   * @param {string} uid
   * @param {boolean} pressedNext
   * @param {number} engaged
   * @param {number | null} partnerRating
   * @returns {Array<{ userId: string, delta: number, reason: string, metadata?: object }>}
   */
  function ledgerRows(uid, pressedNext, engaged, partnerRating) {
    /** @type {Array<{ userId: string, delta: number, reason: string, metadata?: object }>} */
    const rows = []
    const minutePts = Math.min(MAX_MINUTE_POINTS, Math.floor(engaged / 60))
    if (minutePts > 0) {
      rows.push({
        userId: uid,
        delta: minutePts,
        reason: 'session_minutes',
        metadata: { engagedSeconds: engaged },
      })
    }
    const fullSeven =
      session.reachedSevenMinWithoutSkip && !pressedNext ? FULL_SEVEN_BONUS : 0
    if (fullSeven > 0) {
      rows.push({ userId: uid, delta: fullSeven, reason: 'session_full_seven' })
    }
    if (noReports && !pressedNext && partnerRating != null && partnerRating >= 4) {
      rows.push({
        userId: uid,
        delta: INTEGRITY_BONUS,
        reason: 'session_integrity',
        metadata: { partnerRating },
      })
    }
    return rows
  }

  const all = [
    ...ledgerRows(u1, session.user1PressedNext, e1, session.user2Rating),
    ...ledgerRows(u2, session.user2PressedNext, e2, session.user1Rating),
  ]

  if (all.length === 0) {
    await prisma.session.updateMany({
      where: { id: sessionId, cloakRewardsProcessedAt: null },
      data: { cloakRewardsProcessedAt: new Date() },
    })
    return
  }

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.session.findUnique({ where: { id: sessionId } })
    if (!fresh || fresh.cloakRewardsProcessedAt) return

    const byUser = new Map()
    for (const r of all) {
      byUser.set(r.userId, (byUser.get(r.userId) || 0) + r.delta)
    }

    for (const r of all) {
      await tx.cloakScoreLedger.create({
        data: {
          userId: r.userId,
          delta: r.delta,
          reason: r.reason,
          metadata: r.metadata ?? undefined,
          sessionId,
        },
      })
    }

    for (const [userId, sum] of byUser) {
      if (sum > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { cloakScore: { increment: sum } },
        })
      }
    }

    await tx.session.update({
      where: { id: sessionId },
      data: { cloakRewardsProcessedAt: new Date() },
    })
  })

  const cloakAddedByUser = new Map()
  for (const r of all) {
    cloakAddedByUser.set(r.userId, (cloakAddedByUser.get(r.userId) || 0) + r.delta)
  }
  const { tryAwardWalletMilestonesAndNotify } = require('./walletService')
  for (const [uid, sum] of cloakAddedByUser) {
    if (sum > 0) {
      tryAwardWalletMilestonesAndNotify(prisma, uid).catch((err) => {
        console.error('[wallet] milestone after session rewards', uid, err?.message || err)
      })
    }
  }
}

/**
 * Daily login: 5 pts once per IST day + streak bonus min(5*streak, 50).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 */
async function processDailyLoginJob(prisma, userId) {
  const istToday = istCalendarDateString()
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      lastDailyRewardIstDate: true,
      cloakStreakDays: true,
    },
  })
  if (!user) return

  if (user.lastDailyRewardIstDate === istToday) {
    return
  }

  const yesterday = addDaysIstYmd(istToday, -1)
  let streak = 1
  if (user.lastDailyRewardIstDate === yesterday) {
    streak = Math.min(999, (user.cloakStreakDays || 0) + 1)
  }

  const base = 5
  const streakBonus = Math.min(50, 5 * streak)
  const total = base + streakBonus

  await prisma.$transaction([
    prisma.cloakScoreLedger.create({
      data: {
        userId,
        delta: total,
        reason: 'daily_login',
        metadata: { istDate: istToday, streak, base, streakBonus },
      },
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        cloakScore: { increment: total },
        cloakStreakDays: streak,
        lastDailyRewardIstDate: istToday,
      },
    }),
  ])

  const { tryAwardWalletMilestonesAndNotify } = require('./walletService')
  tryAwardWalletMilestonesAndNotify(prisma, userId).catch((err) => {
    console.error('[wallet] milestone after daily login', userId, err?.message || err)
  })
}

module.exports = {
  processSessionRewardsJob,
  processDailyLoginJob,
  istCalendarDateString,
  addDaysIstYmd,
}
