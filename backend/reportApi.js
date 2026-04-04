const { sendWalletEmail } = require('./walletService')

const REPORT_CATEGORIES = new Set([
  'inappropriate_behavior',
  'political_caste_gender_religious',
  'harassment_or_bullying',
  'spam_or_scam',
  'suspected_underage',
  'other',
])

const SUPPORT_EMAIL = process.env.CLOAK_SUPPORT_EMAIL || 'support@cloak.app'

/**
 * @param {import('express').Express} app
 * @param {{
 *  prisma: import('@prisma/client').PrismaClient,
 *  getUserIdFromBearer: (req: import('express').Request) => string | null,
 *  matching: { forceDisconnectUserForModeration?: (userId: string, payload: any) => void } | null,
 * }} ctx
 */
function registerReportApi(app, { prisma, getUserIdFromBearer, matching }) {
  app.post('/api/report', async (req, res) => {
    try {
      const reporterId = getUserIdFromBearer(req)
      if (!reporterId) return res.status(401).json({ message: 'Unauthorized.' })

      const { sessionId, reportedUserId, category, description } = req.body || {}
      const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
      const rid = typeof reportedUserId === 'string' ? reportedUserId.trim() : ''
      const cat = typeof category === 'string' ? category.trim() : ''
      const desc = typeof description === 'string' ? description.trim() : ''

      if (!sid || !rid || !REPORT_CATEGORIES.has(cat)) {
        return res.status(400).json({ message: 'Invalid report payload.' })
      }
      if (cat === 'other' && desc.length < 8) {
        return res.status(400).json({ message: 'Please add a short description (8+ characters).' })
      }
      if (desc.length > 2000) {
        return res.status(400).json({ message: 'Description is too long.' })
      }
      if (rid === reporterId) {
        return res.status(400).json({ message: 'Invalid report.' })
      }

      const session = await prisma.session.findUnique({
        where: { id: sid },
        select: { id: true, user1Id: true, user2Id: true, collegeId: true },
      })
      if (!session) {
        return res.status(404).json({ message: 'Session not found.' })
      }
      if (rid !== session.user1Id && rid !== session.user2Id) {
        return res.status(400).json({ message: 'Reported user is not part of this session.' })
      }
      if (reporterId !== session.user1Id && reporterId !== session.user2Id) {
        return res.status(403).json({ message: 'You are not part of this session.' })
      }

      const reporter = await prisma.user.findUnique({
        where: { id: reporterId },
        select: { collegeId: true },
      })
      if (!reporter || reporter.collegeId !== session.collegeId) {
        return res.status(403).json({ message: 'Invalid session for your account.' })
      }

      const reported = await prisma.user.findUnique({
        where: { id: rid },
        select: { id: true, email: true, collegeId: true, isBanned: true, banExpiresAt: true },
      })
      if (!reported || reported.collegeId !== session.collegeId) {
        return res.status(400).json({ message: 'Invalid reported user.' })
      }

      const now = new Date()
      const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

      const dup = await prisma.report.findFirst({
        where: {
          reporterId,
          reportedUserId: rid,
          sessionId: sid,
        },
        select: { id: true },
      })
      if (dup) {
        return res.status(200).json({ ok: true, duplicate: true })
      }

      await prisma.report.create({
        data: {
          reporterId,
          reportedUserId: rid,
          sessionId: sid,
          category: cat,
          description: cat === 'other' ? desc : desc.length ? desc : null,
          status: 'open',
        },
      })

      const totalReports = await prisma.report.count({
        where: { reportedUserId: rid, createdAt: { gte: since } },
      })

      const distinctRows = await prisma.report.findMany({
        where: { reportedUserId: rid, createdAt: { gte: since } },
        distinct: ['reporterId'],
        select: { reporterId: true },
      })
      const distinctReporterCount = distinctRows.length

      // 2 total reports -> warning email to reported user (anonymous to reporter)
      if (totalReports === 2 && reported.email) {
        await sendWalletEmail({
          to: reported.email,
          subject: 'CLOAK: Community safety warning',
          text:
            'We received multiple community reports associated with your account. Please review CLOAK community guidelines. Continued violations may lead to restrictions.',
          html: `
            <p>Hi,</p>
            <p>We received <strong>multiple community reports</strong> associated with your CLOAK account.</p>
            <p>Please keep conversations respectful and follow our community guidelines.</p>
            <p style="font-size:0.9rem;opacity:0.85">Reports are reviewed in context; this message is informational.</p>
          `,
        }).catch(() => {})
      }

      // 3 distinct reporters within 30 days -> 14 day ban + ban record + email + disconnect
      if (distinctReporterCount >= 3) {
        const alreadyActiveBan =
          reported.isBanned && reported.banExpiresAt && reported.banExpiresAt > now

        if (!alreadyActiveBan) {
          const banUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

          await prisma.$transaction([
            prisma.ban.create({
              data: {
                userId: rid,
                banType: 'auto_reports_3_in_30d',
                startedAt: now,
                expiresAt: banUntil,
                isActive: true,
              },
            }),
            prisma.user.update({
              where: { id: rid },
              data: {
                isBanned: true,
                banExpiresAt: banUntil,
              },
            }),
          ])

          if (reported.email) {
            await sendWalletEmail({
              to: reported.email,
              subject: 'CLOAK: Account restricted for 14 days',
              text: `Your CLOAK account has been restricted until ${banUntil.toISOString()} due to repeated community reports. You may appeal within 7 days by emailing ${SUPPORT_EMAIL}.`,
              html: `
                <p>Hi,</p>
                <p>Your CLOAK account has been <strong>restricted for 14 days</strong> due to repeated community reports from different users within a 30-day window.</p>
                <p><strong>Restriction ends:</strong> ${banUntil.toLocaleString('en-IN')}</p>
                <p>If you believe this is a mistake, you may appeal within <strong>7 days</strong> by emailing
                  <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
                </p>
              `,
            }).catch(() => {})
          }

          matching?.forceDisconnectUserForModeration?.(rid, {
            code: 'ACCOUNT_BANNED',
            message:
              'Your account has been restricted due to repeated community reports. Check your email for details.',
            ban_until: banUntil.toISOString(),
            appeal_email: SUPPORT_EMAIL,
            appeal_days: 7,
          })
        }
      }

      // Never reveal reporter identity to client
      return res.status(200).json({ ok: true })
    } catch (e) {
      console.error('/api/report error:', e)
      return res.status(500).json({ message: 'Failed to submit report.' })
    }
  })
}

module.exports = { registerReportApi, REPORT_CATEGORIES }
