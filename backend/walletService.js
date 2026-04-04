/**
 * CLOAK wallet: CloakScore milestone rewards, PIN helpers, Resend notifications.
 */

const crypto = require('crypto')
const { Prisma } = require('@prisma/client')

const MILESTONES = [
  { key: '1000', points: 1000, amount: 10 },
  { key: '2500', points: 2500, amount: 30 },
  { key: '5000', points: 5000, amount: 75 },
  { key: '10000', points: 10000, amount: 200 },
]

const PIN_REGEX = /^\d{4,6}$/

function hashWalletPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pin), salt, 32)
  return { salt, hashHex: hash.toString('hex') }
}

function verifyWalletPin(pin, salt, hashHex) {
  if (!salt || !hashHex || !PIN_REGEX.test(String(pin))) return false
  try {
    const h = crypto.scryptSync(String(pin), salt, 32)
    const a = Buffer.from(hashHex, 'hex')
    if (a.length !== h.length) return false
    return crypto.timingSafeEqual(a, h)
  } catch {
    return false
  }
}

function validatePinFormat(pin) {
  return PIN_REGEX.test(String(pin || ''))
}

/**
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 */
async function sendWalletEmail(opts) {
  const key = (process.env.RESEND_API_KEY || '').replace(/^['"]|['"]$/g, '').trim()
  if (!key) {
    console.warn('[wallet] RESEND_API_KEY missing — skipping wallet email')
    return { ok: false, reason: 'no_resend' }
  }
  const rawFrom = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
  const fromMatch = rawFrom.match(/<([^>]+)>/)
  const fromEmail = fromMatch ? fromMatch[1] : rawFrom

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CLOAK-WALLET',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text || opts.subject,
      html: opts.html,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[wallet] Resend failed', response.status, body)
    return { ok: false, reason: 'resend_error' }
  }
  return { ok: true }
}

/**
 * Award any eligible CloakScore milestone wallet credits (idempotent per milestone).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @returns {Promise<Array<{ email: string, amountInr: number, points: number }>>}
 */
async function tryAwardWalletMilestones(prisma, userId) {
  /** @type {Array<{ email: string, amountInr: number, points: number }>} */
  const emails = []

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, cloakScore: true },
    })
    if (!user?.email) return

    for (const m of MILESTONES) {
      if (user.cloakScore < m.points) continue

      try {
        await tx.walletMilestoneAward.create({
          data: { userId, milestoneKey: m.key },
        })
      } catch (e) {
        if (e?.code === 'P2002') continue
        throw e
      }

      await tx.walletTransaction.create({
        data: {
          userId,
          amount: new Prisma.Decimal(String(m.amount)),
          reason: `CloakScore milestone reward (${m.points.toLocaleString('en-IN')} points)`,
          type: 'milestone_reward',
          metadata: { milestoneKey: m.key, points: m.points },
        },
      })

      await tx.user.update({
        where: { id: userId },
        data: {
          walletBalance: { increment: new Prisma.Decimal(String(m.amount)) },
        },
      })

      emails.push({ email: user.email, amountInr: m.amount, points: m.points })
    }
  })

  return emails
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 */
async function tryAwardWalletMilestonesAndNotify(prisma, userId) {
  const awarded = await tryAwardWalletMilestones(prisma, userId)
  for (const row of awarded) {
    const html = `
      <p>You earned <strong>₹${row.amountInr}</strong> in your CLOAK wallet.</p>
      <p>Reason: CloakScore reached <strong>${row.points.toLocaleString('en-IN')}</strong> points (milestone reward).</p>
      <p style="font-size:0.9rem;opacity:0.85">Open the app to view your balance and transaction history.</p>
    `
    await sendWalletEmail({
      to: row.email,
      subject: `CLOAK: ₹${row.amountInr} wallet reward`,
      html,
      text: `You earned ₹${row.amountInr} for reaching ${row.points} CloakScore points.`,
    }).catch(() => {})
  }
}

module.exports = {
  MILESTONES,
  hashWalletPin,
  verifyWalletPin,
  validatePinFormat,
  tryAwardWalletMilestones,
  tryAwardWalletMilestonesAndNotify,
  sendWalletEmail,
}
