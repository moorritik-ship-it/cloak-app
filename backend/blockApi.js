const SUPPORT_EMAIL = process.env.CLOAK_SUPPORT_EMAIL || 'support@cloak.app'

/**
 * @param {import('express').Express} app
 * @param {{ prisma: import('@prisma/client').PrismaClient, getUserIdFromBearer: (req: import('express').Request) => string | null }} ctx
 */
function registerBlockApi(app, { prisma, getUserIdFromBearer }) {
  app.post('/api/block', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const { blockedUserId, sessionId } = req.body || {}
      const otherId = typeof blockedUserId === 'string' ? blockedUserId.trim() : ''
      const sid = typeof sessionId === 'string' ? sessionId.trim() : ''

      if (!otherId) return res.status(400).json({ message: 'blockedUserId is required.' })
      if (otherId === userId) return res.status(400).json({ message: 'Invalid user.' })

      if (sid) {
        const sess = await prisma.session.findUnique({
          where: { id: sid },
          select: { id: true, user1Id: true, user2Id: true, collegeId: true },
        })
        if (!sess) return res.status(404).json({ message: 'Session not found.' })
        const inSession = userId === sess.user1Id || userId === sess.user2Id
        const otherInSession = otherId === sess.user1Id || otherId === sess.user2Id
        if (!inSession || !otherInSession) {
          return res.status(403).json({ message: 'You can only block a user from your session.' })
        }
      }

      // Ensure both users are same college (defense-in-depth)
      const [me, other] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { collegeId: true } }),
        prisma.user.findUnique({
          where: { id: otherId },
          select: { id: true, collegeId: true, preferredUsername: true },
        }),
      ])
      if (!me || !other || me.collegeId !== other.collegeId) {
        return res.status(400).json({ message: 'Invalid block target.' })
      }

      // “both directions” so neither can ever match again
      await prisma.$transaction(async (tx) => {
        // ignore if already exists (unique constraint)
        await tx.userBlock
          .create({ data: { blockerId: userId, blockedId: otherId } })
          .catch((e) => {
            if (e?.code !== 'P2002') throw e
          })
        await tx.userBlock
          .create({ data: { blockerId: otherId, blockedId: userId } })
          .catch((e) => {
            if (e?.code !== 'P2002') throw e
          })
      })

      return res.status(200).json({
        ok: true,
        blockedUser: { id: other.id, username: other.preferredUsername ?? 'User' },
      })
    } catch (e) {
      console.error('/api/block error:', e)
      return res.status(500).json({ message: 'Failed to block user.' })
    }
  })

  app.get('/api/blocks', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const rows = await prisma.userBlock.findMany({
        where: { blockerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          createdAt: true,
          blocked: { select: { id: true, preferredUsername: true } },
        },
      })

      return res.status(200).json({
        supportEmail: SUPPORT_EMAIL,
        blocked: rows.map((r) => ({
          id: r.blocked.id,
          username: r.blocked.preferredUsername ?? 'User',
          blockedAt: r.createdAt.toISOString(),
        })),
      })
    } catch (e) {
      console.error('/api/blocks error:', e)
      return res.status(500).json({ message: 'Failed to load blocked users.' })
    }
  })
}

module.exports = { registerBlockApi }

