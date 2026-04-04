const { processSessionRewardsJob, processDailyLoginJob } = require('./cloakScoreProcessor')

/**
 * Bull-backed queue when REDIS_URL (or BULL_REDIS_URL) is set; otherwise setImmediate fallback.
 * @param {{ prisma: import('@prisma/client').PrismaClient }} opts
 */
function createCloakScoreQueue({ prisma }) {
  const redisUrl = process.env.REDIS_URL || process.env.BULL_REDIS_URL
  /** @type {import('bull').Queue | null} */
  let bullQueue = null

  if (redisUrl) {
    try {
      const Queue = require('bull')
      bullQueue = new Queue('cloak-score', redisUrl, {
        defaultJobOptions: {
          removeOnComplete: 200,
          removeOnFail: 100,
        },
      })
      bullQueue.process('session', 8, async (job) => {
        const { sessionId } = job.data || {}
        if (!sessionId) return
        await processSessionRewardsJob(prisma, sessionId)
      })
      bullQueue.process('daily', 8, async (job) => {
        const { userId } = job.data || {}
        if (!userId) return
        await processDailyLoginJob(prisma, userId)
      })
      bullQueue.on('failed', (job, err) => {
        console.error('[cloak] job failed', job?.name, job?.data, err?.message || err)
      })
      console.log('[cloak] Bull queue connected (cloak-score)')
    } catch (e) {
      console.error('[cloak] Bull init failed — using in-process fallback:', e?.message || e)
      bullQueue = null
    }
  } else {
    console.warn('[cloak] REDIS_URL not set — CloakScore jobs run via setImmediate (no Bull)')
  }

  /**
   * @param {string | null | undefined} sessionId
   */
  function enqueueSessionRewards(sessionId) {
    if (!sessionId) return
    if (bullQueue) {
      bullQueue.add('session', { sessionId }, { attempts: 4, backoff: { type: 'exponential', delay: 1500 } })
      return
    }
    setImmediate(() => {
      processSessionRewardsJob(prisma, sessionId).catch((err) =>
        console.error('[cloak] session rewards job:', err?.message || err),
      )
    })
  }

  /**
   * @param {string | null | undefined} userId
   */
  function enqueueDailyLogin(userId) {
    if (!userId) return
    if (bullQueue) {
      bullQueue.add('daily', { userId }, { attempts: 4, backoff: { type: 'exponential', delay: 1500 } })
      return
    }
    setImmediate(() => {
      processDailyLoginJob(prisma, userId).catch((err) =>
        console.error('[cloak] daily login job:', err?.message || err),
      )
    })
  }

  return { enqueueSessionRewards, enqueueDailyLogin, bullQueue }
}

module.exports = { createCloakScoreQueue }
