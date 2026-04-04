const { Prisma } = require('@prisma/client')

const IST_TZ = 'Asia/Kolkata'

function istStartOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return new Date(`${y}-${m}-${d}T00:00:00+05:30`)
}

/**
 * @param {import('express').Request} req
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function requireAdmin(req, prisma) {
  const userId = req.userId
  if (!userId) return { ok: false, status: 401, message: 'Unauthorized.' }
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  })
  if (!row?.isAdmin) return { ok: false, status: 403, message: 'Forbidden.' }
  return { ok: true }
}

/**
 * @param {import('express').Express} app
 * @param {{ prisma: import('@prisma/client').PrismaClient, getUserIdFromBearer: (req: import('express').Request) => string | null }} ctx
 */
function registerAdminApi(app, { prisma, getUserIdFromBearer }) {
  // attach userId for these routes
  app.use('/api/admin', (req, _res, next) => {
    req.userId = getUserIdFromBearer(req)
    next()
  })

  app.get('/api/admin/stats', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const start = istStartOfDay()
      const end = new Date(start)
      end.setDate(end.getDate() + 1)

      const [totalUsers, totalSessionsToday, totalRevenueToday] = await Promise.all([
        prisma.user.count(),
        prisma.session.count({ where: { startedAt: { gte: start, lt: end } } }),
        prisma.walletTransaction.aggregate({
          where: { type: 'topup', createdAt: { gte: start, lt: end } },
          _sum: { amount: true },
        }),
      ])

      // DAU: users who had any session started today
      const dauRows = await prisma.session.findMany({
        where: { startedAt: { gte: start, lt: end } },
        select: { user1Id: true, user2Id: true },
      })
      const dau = new Set()
      for (const r of dauRows) {
        if (r.user1Id) dau.add(r.user1Id)
        if (r.user2Id) dau.add(r.user2Id)
      }

      return res.status(200).json({
        totalUsers,
        dailyActiveUsers: dau.size,
        totalSessionsToday,
        totalRevenueToday: (totalRevenueToday._sum.amount || new Prisma.Decimal(0)).toString(),
      })
    } catch (e) {
      console.error('/api/admin/stats error:', e)
      return res.status(500).json({ message: 'Failed to load stats.' })
    }
  })

  app.get('/api/admin/colleges', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const list = await prisma.college.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          domain: true,
          emailFormatPattern: true,
          isActive: true,
          createdAt: true,
        },
      })
      return res.status(200).json({
        colleges: list.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
      })
    } catch (e) {
      console.error('/api/admin/colleges error:', e)
      return res.status(500).json({ message: 'Failed to load colleges.' })
    }
  })

  app.post('/api/admin/colleges', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const { name, domain, emailFormatPattern } = req.body || {}
      const n = String(name || '').trim()
      const d = String(domain || '').trim().toLowerCase()
      const p = emailFormatPattern != null ? String(emailFormatPattern).trim() : null
      if (!n || !d) return res.status(400).json({ message: 'name and domain are required.' })

      const row = await prisma.college.create({
        data: {
          name: n,
          domain: d,
          emailFormatPattern: p && p.length ? p : null,
          isActive: true,
        },
        select: { id: true },
      })
      return res.status(201).json({ ok: true, id: row.id })
    } catch (e) {
      console.error('/api/admin/colleges create error:', e)
      return res.status(500).json({ message: 'Failed to create college.' })
    }
  })

  app.post('/api/admin/colleges/:id/toggle', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const id = String(req.params.id || '').trim()
      const { isActive } = req.body || {}
      const next = Boolean(isActive)
      const row = await prisma.college.update({
        where: { id },
        data: { isActive: next },
        select: { id: true, isActive: true },
      })
      return res.status(200).json({ ok: true, college: row })
    } catch (e) {
      console.error('/api/admin/colleges toggle error:', e)
      return res.status(500).json({ message: 'Failed to update college.' })
    }
  })

  app.get('/api/admin/reports', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const status = String(req.query.status || 'open').trim()
      const take = Math.min(200, Math.max(1, Number(req.query.take) || 50))

      const rows = await prisma.report.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
        take,
        select: {
          id: true,
          category: true,
          description: true,
          status: true,
          createdAt: true,
          sessionId: true,
          reportedUserId: true,
          reporterId: true, // internal only; do not show in UI as identity
          session: {
            select: {
              id: true,
              startedAt: true,
              endedAt: true,
              endReason: true,
              user1Id: true,
              user2Id: true,
            },
          },
          reportedUser: { select: { id: true, email: true, preferredUsername: true } },
        },
      })

      return res.status(200).json({
        reports: rows.map((r) => ({
          id: r.id,
          category: r.category,
          description: r.description,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          session: r.session
            ? {
                id: r.session.id,
                startedAt: r.session.startedAt.toISOString(),
                endedAt: r.session.endedAt ? r.session.endedAt.toISOString() : null,
                endReason: r.session.endReason || null,
                user1Id: r.session.user1Id,
                user2Id: r.session.user2Id,
              }
            : null,
          reportedUser: {
            id: r.reportedUser.id,
            email: r.reportedUser.email,
            username: r.reportedUser.preferredUsername ?? 'User',
          },
        })),
      })
    } catch (e) {
      console.error('/api/admin/reports error:', e)
      return res.status(500).json({ message: 'Failed to load reports.' })
    }
  })

  app.post('/api/admin/reports/:id/action', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const id = String(req.params.id || '').trim()
      const { action } = req.body || {}
      const a = String(action || '').trim()
      if (!['dismiss', 'warn', 'ban14'].includes(a)) {
        return res.status(400).json({ message: 'Invalid action.' })
      }

      const report = await prisma.report.findUnique({
        where: { id },
        select: { id: true, status: true, reportedUserId: true, reportedUser: { select: { email: true } } },
      })
      if (!report) return res.status(404).json({ message: 'Report not found.' })

      if (a === 'dismiss') {
        await prisma.report.update({ where: { id }, data: { status: 'dismissed' } })
        return res.status(200).json({ ok: true })
      }

      if (a === 'warn') {
        await prisma.report.update({ where: { id }, data: { status: 'actioned_warn' } })
        // optional: send warning email (re-use wallet email sender)
        const { sendWalletEmail } = require('./walletService')
        if (report.reportedUser?.email) {
          sendWalletEmail({
            to: report.reportedUser.email,
            subject: 'CLOAK: Admin warning',
            text: 'An admin reviewed reports associated with your account and issued a warning. Continued violations may lead to a ban.',
            html:
              '<p>An admin reviewed reports associated with your account and issued a <strong>warning</strong>. Continued violations may lead to restrictions.</p>',
          }).catch(() => {})
        }
        return res.status(200).json({ ok: true })
      }

      // ban14
      const now = new Date()
      const until = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
      await prisma.$transaction([
        prisma.ban.create({
          data: { userId: report.reportedUserId, banType: 'admin_ban_14d', startedAt: now, expiresAt: until, isActive: true },
        }),
        prisma.user.update({
          where: { id: report.reportedUserId },
          data: { isBanned: true, banExpiresAt: until },
        }),
        prisma.report.update({ where: { id }, data: { status: 'actioned_ban' } }),
      ])
      return res.status(200).json({ ok: true, banUntil: until.toISOString() })
    } catch (e) {
      console.error('/api/admin/reports action error:', e)
      return res.status(500).json({ message: 'Failed to take action.' })
    }
  })

  app.get('/api/admin/users/search', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const q = String(req.query.q || '').trim()
      if (q.length < 2) return res.status(200).json({ users: [] })

      const users = await prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: q } },
            { preferredUsername: { contains: q } },
          ],
        },
        take: 25,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          preferredUsername: true,
          cloakScore: true,
          walletBalance: true,
          isBanned: true,
          banExpiresAt: true,
          isAdmin: true,
          createdAt: true,
          college: { select: { name: true, domain: true } },
        },
      })

      return res.status(200).json({
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          username: u.preferredUsername ?? 'User',
          cloakScore: u.cloakScore,
          walletBalance: u.walletBalance.toString(),
          isBanned: u.isBanned,
          banExpiresAt: u.banExpiresAt ? u.banExpiresAt.toISOString() : null,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt.toISOString(),
          college: u.college,
        })),
      })
    } catch (e) {
      console.error('/api/admin/users/search error:', e)
      return res.status(500).json({ message: 'Failed to search users.' })
    }
  })

  app.get('/api/admin/users/:id', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const id = String(req.params.id || '').trim()
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          preferredUsername: true,
          cloakScore: true,
          walletBalance: true,
          isBanned: true,
          banExpiresAt: true,
          createdAt: true,
          college: { select: { id: true, name: true, domain: true } },
        },
      })
      if (!user) return res.status(404).json({ message: 'User not found.' })

      const [sessions, reportsAgainst, reportsBy] = await Promise.all([
        prisma.session.findMany({
          where: { OR: [{ user1Id: id }, { user2Id: id }] },
          orderBy: { startedAt: 'desc' },
          take: 50,
          select: { id: true, startedAt: true, endedAt: true, endReason: true, collegeId: true },
        }),
        prisma.report.findMany({
          where: { reportedUserId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, category: true, status: true, createdAt: true, sessionId: true },
        }),
        prisma.report.findMany({
          where: { reporterId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, category: true, status: true, createdAt: true, sessionId: true },
        }),
      ])

      return res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          username: user.preferredUsername ?? 'User',
          cloakScore: user.cloakScore,
          walletBalance: user.walletBalance.toString(),
          isBanned: user.isBanned,
          banExpiresAt: user.banExpiresAt ? user.banExpiresAt.toISOString() : null,
          createdAt: user.createdAt.toISOString(),
          college: user.college,
        },
        sessions: sessions.map((s) => ({
          ...s,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        })),
        reportsAgainst: reportsAgainst.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        reportsBy: reportsBy.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      })
    } catch (e) {
      console.error('/api/admin/users/:id error:', e)
      return res.status(500).json({ message: 'Failed to load user.' })
    }
  })

  app.post('/api/admin/users/:id/ban', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const id = String(req.params.id || '').trim()
      const { days } = req.body || {}
      const d = Math.min(365, Math.max(1, Number(days) || 14))
      const now = new Date()
      const until = new Date(now.getTime() + d * 24 * 60 * 60 * 1000)
      await prisma.$transaction([
        prisma.ban.create({
          data: { userId: id, banType: 'admin_manual', startedAt: now, expiresAt: until, isActive: true },
        }),
        prisma.user.update({ where: { id }, data: { isBanned: true, banExpiresAt: until } }),
      ])
      return res.status(200).json({ ok: true, banUntil: until.toISOString() })
    } catch (e) {
      console.error('/api/admin/users/:id/ban error:', e)
      return res.status(500).json({ message: 'Failed to ban user.' })
    }
  })

  app.post('/api/admin/users/:id/unban', async (req, res) => {
    try {
      const guard = await requireAdmin(req, prisma)
      if (!guard.ok) return res.status(guard.status).json({ message: guard.message })

      const id = String(req.params.id || '').trim()
      await prisma.user.update({ where: { id }, data: { isBanned: false, banExpiresAt: null } })
      // Keep historical ban rows; don't delete.
      return res.status(200).json({ ok: true })
    } catch (e) {
      console.error('/api/admin/users/:id/unban error:', e)
      return res.status(500).json({ message: 'Failed to unban user.' })
    }
  })
}

module.exports = { registerAdminApi }

