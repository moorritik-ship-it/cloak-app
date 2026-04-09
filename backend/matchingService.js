const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const ACTIVE_COLLEGES_KEY = 'matching:active_colleges'
const QUEUE_PREFIX = 'matching:'
const SOCKET_META_PREFIX = 'matching:socket:'
const PAIR_COOLDOWN_PREFIX = 'cloak:lastmatch:'
const MATCH_INTERVAL_MS = 500
const QUEUE_TIMEOUT_MS = 60_000
const PAIR_COOLDOWN_SEC = 30 * 60

/** Omegle-style Next: max skips per rolling hour, then 10 min lockout */
const SKIP_WINDOW_MS = 60 * 60 * 1000
const SKIP_MAX_PER_WINDOW = 30
const SKIP_LOCK_SEC = 10 * 60
const SKIP_LOCK_PREFIX = 'matching:skip_lock:'
const SKIP_ZSET_PREFIX = 'matching:skip_z:'

const CHAT_MAX_GRAPHEMES = 500
const POST_SESSION_MS = 5 * 60 * 1000
/** Time to submit star rating before post-session chat opens (same window feel as post-session) */
const RATING_PHASE_MS = 5 * 60 * 1000

/** Live video session: 7 min, optional extension to 14 min total from match start */
const SESSION_LIVE_MS = 7 * 60 * 1000
const SESSION_EXTENDED_TOTAL_MS = 14 * 60 * 1000
const EXTENSION_AMOUNT_PAISE = 2000
/** Payment modal at 6:00 elapsed (1:00 left); decision window until 7:00 */
const EXTENSION_OFFER_AT_MS = 6 * 60 * 1000
const PAYMENT_WINDOW_MS = 60 * 1000
const HARD_END_FIRST_MS = 7 * 60 * 1000
const FREE_VIDEO_BAN_DAYS = 7

/** One-shot: after ₹20 Razorpay verify, user may join queue once while banned */
const QUEUE_PAID_UNLOCK_PREFIX = 'matching:queue_paid_unlock:'

/** Test override: allow these accounts to match regardless of collegeId */
const TEST_MATCH_EMAILS = new Set(['moorritik@gmail.com', 'moorritik6@gmail.com'])
const TEST_COLLEGE_ID = '__test__'
const DEBUG_MATCHING = process.env.DEBUG_MATCHING === '1'

function isTestCollegeId(collegeId) {
  const c = String(collegeId || '').trim().toLowerCase()
  return c === TEST_COLLEGE_ID || c === 'test'
}

/**
 * @param {string} a
 * @param {string} b
 */
function pairCooldownKey(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a]
  return `${PAIR_COOLDOWN_PREFIX}${x}:${y}`
}

/**
 * @param {import('@upstash/redis').Redis | null} redis
 * @param {{ enqueueSessionRewards?: (sessionId: string) => void } | null | undefined} cloakQueue
 */
function createMatchingService({ io, prisma, redis, accessTokenSecret, cloakQueue }) {
  /** @type {Map<string, NodeJS.Timeout>} */
  const queueTimeouts = new Map()

  /**
   * In-memory fallback queue used when Redis isn't configured.
   * This still matches across devices as long as you run a single backend instance.
   * @type {Map<string, Array<{ socketId: string, userId: string, username: string, collegeId: string, joinedAt: number }>>}
   */
  const memQueues = new Map()

  /** room_id -> { sockets: [socketId, socketId] } for WebRTC signaling */
  const activeMatchRooms = new Map()

  /** room_id -> NodeJS.Timeout for post-session 5m auto-close */
  const postSessionTimers = new Map()

  /** room_id -> expires_at_ms (wall clock) for idempotent session_end_natural */
  const postSessionExpiryMs = new Map()

  let RazorpayCtor = null
  try {
    RazorpayCtor = require('razorpay')
  } catch (_) {
    /* optional dep */
  }
  const razorpayKeyId = process.env.RAZORPAY_KEY_ID || ''
  const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || ''
  const extensionPaymentMock =
    process.env.EXTENSION_PAYMENT_MOCK === 'true' || process.env.EXTENSION_PAYMENT_MOCK === '1'
  let razorpayInstance = null
  if (RazorpayCtor && razorpayKeyId && razorpayKeySecret && !extensionPaymentMock) {
    try {
      razorpayInstance = new RazorpayCtor({ key_id: razorpayKeyId, key_secret: razorpayKeySecret })
    } catch (e) {
      console.error('[matching] Razorpay init failed:', e?.message)
    }
  }

  if (!redis) {
    console.warn('[matching] Upstash Redis not configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN')
  }

  /**
   * @param {{ userIds: string[], cloakEngagedSeconds?: Record<string, number> }} room
   * @returns {{ u1: number, u2: number }}
   */
  function getEngagementSnapshot(room) {
    const [a, b] = room.userIds
    const u1id = a < b ? a : b
    const u2id = a < b ? b : a
    const eg = room.cloakEngagedSeconds || {}
    return {
      u1: Math.min(7 * 60, Math.max(0, eg[u1id] || 0)),
      u2: Math.min(7 * 60, Math.max(0, eg[u2id] || 0)),
    }
  }

  function freeVideoBanUntilDate() {
    return new Date(Date.now() + FREE_VIDEO_BAN_DAYS * 24 * 60 * 60 * 1000)
  }

  /**
   * After successful ₹20 payment while banned — allows one join_queue before consuming.
   * @param {string} userId
   */
  async function grantPaidQueueUnlock(userId) {
    if (!redis) return
    const key = `${QUEUE_PAID_UNLOCK_PREFIX}${userId}`
    await redis.set(key, '1', { ex: 2 * 60 * 60 })
  }

  /**
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async function consumePaidQueueUnlock(userId) {
    if (!redis) return false
    const key = `${QUEUE_PAID_UNLOCK_PREFIX}${userId}`
    const v = await redis.get(key)
    if (v == null) return false
    await redis.del(key)
    return true
  }

  function clearQueueTimeout(socketId) {
    const t = queueTimeouts.get(socketId)
    if (t) {
      clearTimeout(t)
      queueTimeouts.delete(socketId)
    }
  }

  /**
   * @param {string} collegeId
   * @param {string} socketId
   */
  async function removeSocketFromQueue(collegeId, socketId) {
    clearQueueTimeout(socketId)
    if (!redis) {
      const q = memQueues.get(collegeId) || []
      const next = q.filter((e) => e.socketId !== socketId)
      if (next.length) memQueues.set(collegeId, next)
      else memQueues.delete(collegeId)
      return
    }
    const queueKey = `${QUEUE_PREFIX}${collegeId}`
    await redis.lrem(queueKey, 1, socketId)
    await redis.del(`${SOCKET_META_PREFIX}${socketId}`)
    const len = await redis.llen(queueKey)
    if (len === 0) {
      await redis.srem(ACTIVE_COLLEGES_KEY, collegeId)
    }
  }

  /**
   * @param {import('socket.io').Socket} socket
   */
  async function handleDisconnect(socket) {
    if (!socket.data?.inQueue || !socket.data?.collegeId) return
    await removeSocketFromQueue(socket.data.collegeId, socket.id)
    socket.data.inQueue = false
  }

  /**
   * @param {string} socketId
   */
  function clearPostSessionTimer(roomId) {
    const t = postSessionTimers.get(roomId)
    if (t) {
      clearTimeout(t)
      postSessionTimers.delete(roomId)
    }
    postSessionExpiryMs.delete(roomId)
  }

  /**
   * @param {import('socket.io').Socket} socket
   */
  function removeSocketFromMatchRooms(socket) {
    const socketId = socket.id
    for (const [roomId, room] of activeMatchRooms.entries()) {
      if (!room.sockets.includes(socketId)) continue
      const other = room.sockets.find((id) => id !== socketId)
      const inPostSession = postSessionTimers.has(roomId)
      const inRatingPhase = Boolean(room.ratingPhase?.active)

      socket.data.matchRoomId = undefined

      if (inPostSession) {
        room.sockets = room.sockets.filter((id) => id !== socketId)
        if (other) {
          io.to(other).emit('webrtc_peer_disconnected', { room_id: roomId })
        }
        if (room.sockets.length === 0) {
          clearPostSessionTimer(roomId)
          clearRoomTimers(room)
          activeMatchRooms.delete(roomId)
        }
        return
      }

      if (inRatingPhase) {
        room.sockets = room.sockets.filter((id) => id !== socketId)
        if (other) {
          io.to(other).emit('webrtc_peer_disconnected', { room_id: roomId })
        }
        if (room.sockets.length === 0) {
          clearRatingPhase(room)
          clearPostSessionTimer(roomId)
          clearRoomTimers(room)
          activeMatchRooms.delete(roomId)
        }
        return
      }

      clearPostSessionTimer(roomId)
      clearRoomTimers(room)
      activeMatchRooms.delete(roomId)
      if (other) {
        io.to(other).emit('webrtc_peer_disconnected', { room_id: roomId })
      }
      return
    }
  }

  /**
   * @param {import('socket.io').Socket} fromSocket
   * @param {string} roomId
   * @param {string} eventName
   * @param {object} payload
   */
  function relayToPeer(fromSocket, roomId, eventName, payload) {
    const room = activeMatchRooms.get(roomId)
    if (!room || !room.sockets.includes(fromSocket.id)) return
    const other = room.sockets.find((id) => id !== fromSocket.id)
    if (!other) return
    io.to(other).emit(eventName, payload)
  }

  /**
   * @param {string} roomId
   * @param {string} eventName
   * @param {object} payload
   */
  function broadcastToMatchRoom(roomId, eventName, payload) {
    const room = activeMatchRooms.get(roomId)
    if (!room) return
    for (const sid of room.sockets) {
      io.to(sid).emit(eventName, payload)
    }
  }

  /**
   * @param {{ sockets: string[], timers?: NodeJS.Timeout[], hardEndTimer?: NodeJS.Timeout | null } | undefined} room
   */
  function clearRoomTimers(room) {
    if (!room) return
    if (room.timers?.length) {
      room.timers.forEach((t) => clearTimeout(t))
      room.timers = []
    }
    if (room.hardEndTimer) {
      clearTimeout(room.hardEndTimer)
      room.hardEndTimer = null
    }
    clearRatingPhase(room)
  }

  /**
   * @param {{ ratingPhase?: { timer?: NodeJS.Timeout | null, active?: boolean } } | undefined} room
   */
  function clearRatingPhase(room) {
    if (!room?.ratingPhase) return
    if (room.ratingPhase.timer) clearTimeout(room.ratingPhase.timer)
    room.ratingPhase = null
  }

  function finishRatingPhase(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room?.ratingPhase?.active) return
    clearRatingPhase(room)
    startPostSessionForRoom(roomId)
  }

  /**
   * After a natural-style session end (not Next/skip): collect 1–5 star ratings, then post-session chat.
   * Idempotent per room.
   */
  async function beginRatingPhase(roomId) {
    if (postSessionTimers.has(roomId)) return
    const room = activeMatchRooms.get(roomId)
    if (!room) return
    if (room.ratingPhase?.active) return

    if (!room.dbSessionId || !prisma) {
      startPostSessionForRoom(roomId)
      return
    }

    room.liveSessionEnded = true
    const deadlineMs = Date.now() + RATING_PHASE_MS
    room.ratingPhase = {
      active: true,
      submitted: new Set(),
      deadlineMs,
    }
    room.ratingPhase.timer = setTimeout(() => {
      finishRatingPhase(roomId)
    }, RATING_PHASE_MS)

    /** @type {Record<string, string>} */
    const peerNames = {}
    for (const sid of room.sockets) {
      const otherSid = room.sockets.find((id) => id !== sid)
      const otherSock = otherSid ? io.sockets.sockets.get(otherSid) : null
      peerNames[sid] = otherSock ? await resolveQueueUsername(otherSock) : 'Peer'
    }

    for (const sid of room.sockets) {
      io.to(sid).emit('rating_phase_started', {
        room_id: roomId,
        session_id: room.dbSessionId,
        peer_username: peerNames[sid] || 'Peer',
        deadline_ms: deadlineMs,
      })
    }
  }

  /**
   * @param {string} roomId
   */
  async function finalizeSessionInDb(roomId, endReason) {
    const room = activeMatchRooms.get(roomId)
    if (!room?.dbSessionId || !prisma) return
    try {
      const { u1, u2 } = getEngagementSnapshot(room)
      await prisma.session.updateMany({
        where: { id: room.dbSessionId, endedAt: null },
        data: {
          user1EngagedSeconds: u1,
          user2EngagedSeconds: u2,
          endedAt: new Date(),
          durationSeconds: Math.max(0, Math.floor((Date.now() - room.sessionStartMs) / 1000)),
          endReason,
        },
      })
      cloakQueue?.enqueueSessionRewards(room.dbSessionId)
    } catch (e) {
      console.error('[matching] finalizeSessionInDb:', e)
    }
  }

  function startPostSessionForRoom(roomId) {
    if (postSessionTimers.has(roomId)) return
    const room = activeMatchRooms.get(roomId)
    if (!room) return
    const expiresAt = Date.now() + POST_SESSION_MS
    postSessionExpiryMs.set(roomId, expiresAt)
    const payloadEv = { room_id: roomId, expires_at_ms: expiresAt }
    broadcastToMatchRoom(roomId, 'post_session_started', payloadEv)
    const timer = setTimeout(() => {
      postSessionTimers.delete(roomId)
      postSessionExpiryMs.delete(roomId)
      broadcastToMatchRoom(roomId, 'post_session_closed', { room_id: roomId })
      finalizeSessionInDb(roomId, 'completed').catch((e) => console.error('[matching] finalize on post close:', e))
    }, POST_SESSION_MS)
    postSessionTimers.set(roomId, timer)
  }

  async function tryExtendSession(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room || room.extended) return
    room.extended = true
    clearRoomTimers(room)
    const newEndMs = room.sessionStartMs + SESSION_EXTENDED_TOTAL_MS
    const delay = Math.max(0, newEndMs - Date.now())
    room.hardEndTimer = setTimeout(() => {
      handleRoomHardEndFourteen(roomId).catch((e) => console.error('[matching] hard end 14:', e))
    }, delay)
    broadcastToMatchRoom(roomId, 'session_extended', {
      room_id: roomId,
      session_end_at_ms: newEndMs,
      session_start_at_ms: room.sessionStartMs,
    })
  }

  async function handleRoomHardEndFourteen(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room?.extended) return
    await beginRatingPhase(roomId)
  }

  async function handleRoomHardEndSeven(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room) return
    if (room.extended) return

    if (room.dbSessionId && prisma && room.sockets.length === 2) {
      try {
        await prisma.session.update({
          where: { id: room.dbSessionId },
          data: { reachedSevenMinWithoutSkip: true },
        })
      } catch (e) {
        console.error('[matching] reachedSevenMinWithoutSkip:', e)
      }
    }

    const ext = room.extensionState
    const paidIds = ext?.byUserId
      ? Object.entries(ext.byUserId)
          .filter(([, v]) => v.paid)
          .map(([uid]) => uid)
      : []

    if (paidIds.length === 2) {
      await tryExtendSession(roomId)
      return
    }

    const banUntil = freeVideoBanUntilDate()

    if (paidIds.length === 0) {
      await prisma.user.updateMany({
        where: { id: { in: room.userIds } },
        data: { freeVideoChatBanUntil: banUntil },
      })
      broadcastToMatchRoom(roomId, 'session_payment_outcome', {
        room_id: roomId,
        outcome: 'neither_paid',
        ban_until: banUntil.toISOString(),
        message:
          'Neither participant paid to extend. Free video chat is restricted for 7 days for both users.',
      })
      room.extensionState = null
      await beginRatingPhase(roomId)
      return
    }

    if (paidIds.length === 1) {
      const payerId = paidIds[0]
      const nonPayerId = room.userIds.find((id) => id !== payerId)
      if (!nonPayerId) {
        room.extensionState = null
        await beginRatingPhase(roomId)
        return
      }

      await prisma.user.update({
        where: { id: nonPayerId },
        data: { freeVideoChatBanUntil: banUntil },
      })

      const dbSessionIdRematch = room.dbSessionId
      const sessionStartMsRematch = room.sessionStartMs
      const { u1: engU1r, u2: engU2r } = getEngagementSnapshot(room)
      clearPostSessionTimer(roomId)
      clearRoomTimers(room)
      activeMatchRooms.delete(roomId)

      if (dbSessionIdRematch && prisma) {
        try {
          await prisma.session.update({
            where: { id: dbSessionIdRematch },
            data: {
              user1EngagedSeconds: engU1r,
              user2EngagedSeconds: engU2r,
              endedAt: new Date(),
              durationSeconds: Math.max(0, Math.floor((Date.now() - sessionStartMsRematch) / 1000)),
              endReason: 'rematch_split',
            },
          })
          cloakQueue?.enqueueSessionRewards(dbSessionIdRematch)
        } catch (e) {
          console.error('[matching] session rematch_split:', e)
        }
      }

      const payerSocketId = room.sockets.find((sid) => {
        const s = io.sockets.sockets.get(sid)
        return s && s.data.userId === payerId
      })
      const nonPayerSocketId = room.sockets.find((sid) => {
        const s = io.sockets.sockets.get(sid)
        return s && s.data.userId === nonPayerId
      })

      const payerSocket = payerSocketId ? io.sockets.sockets.get(payerSocketId) : null
      const nonPayerSocket = nonPayerSocketId ? io.sockets.sockets.get(nonPayerSocketId) : null

      if (payerSocket) payerSocket.data.matchRoomId = undefined
      if (nonPayerSocket) nonPayerSocket.data.matchRoomId = undefined

      if (nonPayerSocket) {
        nonPayerSocket.emit('free_video_ban', {
          ban_until: banUntil.toISOString(),
          message:
            'Your partner paid to extend; you did not. Free Find Match is restricted for 7 days — pay ₹20 to start a session.',
        })
        nonPayerSocket.emit('peer_moved_on', {
          message: 'Your partner is finding a new match. Session ended.',
        })
      }

      if (payerSocket) {
        payerSocket.emit('session_payer_rematch', {
          message: 'Finding you a new match for free…',
        })
        const u = await resolveQueueUsername(payerSocket)
        await enqueueSocket(payerSocket, u)
      }
    }
  }

  async function openExtensionPaymentWindow(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room || room.extended) return

    const ext = {
      byUserId: {},
      deadlineMs: room.sessionStartMs + HARD_END_FIRST_MS,
    }

    const paymentAvailable = Boolean(extensionPaymentMock || razorpayInstance)

    for (const uid of room.userIds) {
      let orderId = `mock_${roomId}_${uid}`
      if (!extensionPaymentMock && razorpayInstance) {
        const receipt = `ex${crypto.randomBytes(8).toString('hex')}`.slice(0, 40)
        const order = await razorpayInstance.orders.create({
          amount: EXTENSION_AMOUNT_PAISE,
          currency: 'INR',
          receipt: receipt.slice(0, 40),
          notes: { room_id: roomId, user_id: uid },
        })
        orderId = order.id
      }
      ext.byUserId[uid] = { orderId, paid: false }
    }

    room.extensionState = ext

    const deadline = ext.deadlineMs

    for (const sid of room.sockets) {
      const sock = io.sockets.sockets.get(sid)
      if (!sock) continue
      const uid = sock.data.userId
      const ord = uid && ext.byUserId[uid]
      if (!ord) continue
      sock.emit('session_extension_offer', {
        room_id: roomId,
        extension_deadline_ms: deadline,
        payment_window_ms: PAYMENT_WINDOW_MS,
        modal_message: 'Pay ₹20 to extend this chat — you have 1 minute to decide',
        razorpay_key_id: razorpayKeyId,
        razorpay_order_id: ord.orderId,
        amount: EXTENSION_AMOUNT_PAISE,
        currency: 'INR',
        payment_available: paymentAvailable,
      })
    }
  }

  function scheduleMatchRoomLifecycle(roomId) {
    const room = activeMatchRooms.get(roomId)
    if (!room) return
    room.timers = []
    const push = (fn, delay) => {
      const t = setTimeout(fn, delay)
      room.timers.push(t)
    }
    push(() => {
      openExtensionPaymentWindow(roomId).catch((e) => console.error('[matching] extension offer:', e))
    }, EXTENSION_OFFER_AT_MS)
    room.hardEndTimer = setTimeout(() => {
      handleRoomHardEndSeven(roomId).catch((e) => console.error('[matching] hard end 7:', e))
    }, HARD_END_FIRST_MS)
  }

  /**
   * @param {string} userId
   * @param {string} roomId
   * @param {string} razorpay_order_id
   * @param {string} razorpay_payment_id
   * @param {string} razorpay_signature
   */
  async function verifyExtensionPayment({
    userId,
    roomId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  }) {
    const room = activeMatchRooms.get(roomId)
    if (!room || !room.userIds?.includes(userId)) {
      throw new Error('Invalid room or not in this match.')
    }
    const ext = room.extensionState
    if (!ext?.byUserId) {
      throw new Error('Extension window is not active.')
    }
    if (Date.now() > ext.deadlineMs) {
      throw new Error('Payment deadline passed.')
    }

    const entry = ext.byUserId[userId]
    if (!entry || entry.orderId !== razorpay_order_id) {
      throw new Error('Invalid order for this user.')
    }
    if (entry.paid) {
      return { ok: true, already: true, extended: Boolean(room.extended) }
    }

    const isMockOrder = String(razorpay_order_id).startsWith('mock_')
    const allowDevMockVerify = extensionPaymentMock || (!razorpayKeySecret && isMockOrder)
    if (allowDevMockVerify) {
      if (!isMockOrder) {
        throw new Error('Invalid order for dev/mock verification.')
      }
    } else {
      if (!razorpayKeySecret) {
        throw new Error('Payments are not configured on the server.')
      }
      const expected = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex')
      if (expected !== razorpay_signature) {
        throw new Error('Invalid payment signature.')
      }
    }

    entry.paid = true

    const paidCount = Object.values(ext.byUserId).filter((x) => x.paid).length
    if (paidCount === 2 && Date.now() <= ext.deadlineMs) {
      await tryExtendSession(roomId)
      return { ok: true, extended: true }
    }
    return { ok: true, extended: false }
  }

  /**
   * Create Razorpay order for ₹20 — one queue join while free-video banned.
   * @param {string} userId
   */
  async function createQueueUnlockOrder(userId) {
    if (!extensionPaymentMock && !razorpayInstance) {
      throw new Error('Payments are not configured (set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET or EXTENSION_PAYMENT_MOCK=true).')
    }
    let orderId = `mock_qu_${userId}_${Date.now()}`
    if (!extensionPaymentMock && razorpayInstance) {
      const order = await razorpayInstance.orders.create({
        amount: EXTENSION_AMOUNT_PAISE,
        currency: 'INR',
        receipt: `qu${crypto.randomBytes(8).toString('hex')}`.slice(0, 40),
        notes: { type: 'queue_unlock', user_id: userId },
      })
      orderId = order.id
    }
    return {
      order_id: orderId,
      amount: EXTENSION_AMOUNT_PAISE,
      currency: 'INR',
      razorpay_key_id: razorpayKeyId,
    }
  }

  /**
   * @param {string} userId
   * @param {string} razorpay_order_id
   * @param {string} razorpay_payment_id
   * @param {string} razorpay_signature
   */
  async function verifyQueueUnlockPayment({
    userId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  }) {
    const isMock = String(razorpay_order_id).startsWith(`mock_qu_${userId}_`)
    const allowDevMock = extensionPaymentMock || (!razorpayKeySecret && isMock)
    if (allowDevMock) {
      if (!isMock) {
        throw new Error('Invalid mock queue unlock order.')
      }
    } else {
      if (!razorpayKeySecret) {
        throw new Error('Payments are not configured on the server.')
      }
      const expected = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex')
      if (expected !== razorpay_signature) {
        throw new Error('Invalid payment signature.')
      }
    }
    await grantPaidQueueUnlock(userId)
    return { ok: true }
  }

  /**
   * @param {string} text
   */
  function countGraphemes(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length
    }
    return Array.from(text).length
  }

  /**
   * @param {string} userIdA
   * @param {string} userIdB
   */
  async function areBlockedPair(userIdA, userIdB) {
    const row = await prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: userIdA, blockedId: userIdB },
          { blockerId: userIdB, blockedId: userIdA },
        ],
      },
      select: { id: true },
    })
    return Boolean(row)
  }

  /**
   * @param {string} userIdA
   * @param {string} userIdB
   */
  async function inRecentMatchCooldown(userIdA, userIdB) {
    if (!redis) return false
    const n = await redis.exists(pairCooldownKey(userIdA, userIdB))
    return Number(n ?? 0) > 0
  }

  /**
   * @param {string} userIdA
   * @param {string} userIdB
   */
  async function recordPairCooldown(userIdA, userIdB) {
    if (!redis) return
    const key = pairCooldownKey(userIdA, userIdB)
    await redis.set(key, String(Date.now()), { ex: PAIR_COOLDOWN_SEC })
  }

  /**
   * @param {{ userId: string, socketId: string, username: string, collegeId: string }} a
   * @param {{ userId: string, socketId: string, username: string, collegeId: string }} b
   */
  async function canMatchPair(a, b) {
    if (a.userId === b.userId) return false
    // Test override: when both users are in the test queue, bypass block/cooldown checks.
    if (isTestCollegeId(a.collegeId) && isTestCollegeId(b.collegeId)) return true
    if (await areBlockedPair(a.userId, b.userId)) return false
    if (await inRecentMatchCooldown(a.userId, b.userId)) return false
    return true
  }

  /**
   * @param {string} collegeId
   */
  async function tryMatchCollege(collegeId) {
    if (!redis) return
    const queueKey = `${QUEUE_PREFIX}${collegeId}`
    const len = await redis.llen(queueKey)
    if (DEBUG_MATCHING) console.log('[matching] tryMatchCollege', { collegeId, len })
    if (len < 2) return

    const socketIds = await redis.lrange(queueKey, 0, len - 1)
    /** @type {Array<{ userId: string, socketId: string, username: string, collegeId: string }>} */
    const entries = []

    for (const sid of socketIds) {
      const raw = await redis.get(`${SOCKET_META_PREFIX}${sid}`)
      if (!raw) {
        await redis.lrem(queueKey, 1, sid)
        continue
      }
      try {
        const meta = JSON.parse(raw)
        entries.push({
          userId: meta.userId,
          socketId: sid,
          username: String(meta.username || 'Anonymous'),
          collegeId: meta.collegeId || collegeId,
        })
      } catch {
        await redis.lrem(queueKey, 1, sid)
      }
    }

    if (entries.length < 2) {
      const lenAfter = await redis.llen(queueKey)
      if (lenAfter === 0) await redis.srem(ACTIVE_COLLEGES_KEY, collegeId)
      return
    }

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const A = entries[i]
        const B = entries[j]
        const ok = await canMatchPair(A, B)
        if (!ok) {
          if (DEBUG_MATCHING) {
            const blocked = await areBlockedPair(A.userId, B.userId)
            const cooldown = await inRecentMatchCooldown(A.userId, B.userId)
            console.log('[matching] pair_rejected', {
              collegeId,
              A: { userId: A.userId, socketId: A.socketId },
              B: { userId: B.userId, socketId: B.socketId },
              blocked,
              cooldown,
            })
          }
          continue
        }

        await redis.lrem(queueKey, 1, A.socketId)
        await redis.lrem(queueKey, 1, B.socketId)
        await redis.del(`${SOCKET_META_PREFIX}${A.socketId}`)
        await redis.del(`${SOCKET_META_PREFIX}${B.socketId}`)
        clearQueueTimeout(A.socketId)
        clearQueueTimeout(B.socketId)

        const roomId = crypto.randomUUID()
        /** Lexicographically smaller userId creates the WebRTC offer (simple-peer initiator) */
        const aIsOfferer = A.userId < B.userId
        const payloadA = {
          room_id: roomId,
          peer_username: B.username,
          peer_user_id: B.userId,
          is_offerer: aIsOfferer,
        }
        const payloadB = {
          room_id: roomId,
          peer_username: A.username,
          peer_user_id: A.userId,
          is_offerer: !aIsOfferer,
        }

        await recordPairCooldown(A.userId, B.userId)

        const sessionStartMs = Date.now()
        const matchRoom = {
          sockets: [A.socketId, B.socketId],
          userIds: [A.userId, B.userId],
          sessionStartMs,
          timers: [],
          hardEndTimer: null,
          extended: false,
          extensionState: null,
          dbSessionId: null,
          liveSessionEnded: false,
          cloakEngagedSeconds: {},
        }

        if (prisma) {
          try {
            const u1 = A.userId < B.userId ? A : B
            const u2 = A.userId < B.userId ? B : A
            const row = await prisma.session.create({
              data: {
                user1Id: u1.userId,
                user2Id: u2.userId,
                collegeId: collegeId,
                user1Username: u1.username.slice(0, 64),
                user2Username: u2.username.slice(0, 64),
                matchRoomId: roomId,
              },
            })
            matchRoom.dbSessionId = row.id
            payloadA.session_id = row.id
            payloadB.session_id = row.id
          } catch (e) {
            console.error('[matching] session create:', e)
          }
        }

        activeMatchRooms.set(roomId, matchRoom)
        scheduleMatchRoomLifecycle(roomId)

        payloadA.session_start_at_ms = sessionStartMs
        payloadA.session_end_at_ms = sessionStartMs + SESSION_LIVE_MS
        payloadB.session_start_at_ms = sessionStartMs
        payloadB.session_end_at_ms = sessionStartMs + SESSION_LIVE_MS

        io.to(A.socketId).emit('match_found', payloadA)
        io.to(B.socketId).emit('match_found', payloadB)
        console.log('[matching] match_found', {
          roomId,
          collegeId,
          A: { socketId: A.socketId, userId: A.userId, username: A.username },
          B: { socketId: B.socketId, userId: B.userId, username: B.username },
          via: 'redis',
        })

        const sockA = io.sockets.sockets.get(A.socketId)
        const sockB = io.sockets.sockets.get(B.socketId)
        if (sockA) sockA.data.inQueue = false
        if (sockB) sockB.data.inQueue = false

        await tryMatchCollege(collegeId)
        return
      }
    }
  }

  /**
   * @param {string} userId
   * @returns {Promise<{ locked: boolean, ttlSec?: number, lockedUntilMs?: number }>}
   */
  async function checkSkipRateLimit(userId) {
    if (!redis) return { locked: false }
    const lockKey = `${SKIP_LOCK_PREFIX}${userId}`
    const exists = await redis.exists(lockKey)
    if (Number(exists ?? 0) > 0) {
      const ttl = await redis.ttl(lockKey)
      const sec = typeof ttl === 'number' && ttl > 0 ? ttl : SKIP_LOCK_SEC
      return { locked: true, ttlSec: sec, lockedUntilMs: Date.now() + sec * 1000 }
    }
    const zkey = `${SKIP_ZSET_PREFIX}${userId}`
    const now = Date.now()
    const cutoff = now - SKIP_WINDOW_MS
    if (cutoff > 0) {
      await redis.zremrangebyscore(zkey, 0, cutoff)
    }
    const n = await redis.zcard(zkey)
    if (typeof n === 'number' && n >= SKIP_MAX_PER_WINDOW) {
      await redis.set(lockKey, '1', { ex: SKIP_LOCK_SEC })
      return { locked: true, ttlSec: SKIP_LOCK_SEC, lockedUntilMs: Date.now() + SKIP_LOCK_SEC * 1000 }
    }
    return { locked: false }
  }

  /**
   * @param {string} userId
   */
  async function recordSkipForUser(userId) {
    if (!redis) return
    const zkey = `${SKIP_ZSET_PREFIX}${userId}`
    const now = Date.now()
    const member = `${now}:${crypto.randomBytes(8).toString('hex')}`
    await redis.zadd(zkey, { score: now, member })
    await redis.expire(zkey, Math.ceil(SKIP_WINDOW_MS / 1000) + 120)
  }

  /**
   * @param {import('socket.io').Socket} socket
   */
  async function resolveQueueUsername(socket) {
    const u = socket.data.queueUsername
    if (typeof u === 'string') {
      const t = u.trim()
      if (t.length >= 2 && t.length <= 20) return t
    }
    const userId = socket.data.userId
    if (!userId) {
      return `anon${10 + Math.floor(Math.random() * 89)}`
    }
    try {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferredUsername: true },
      })
      const raw = String(row?.preferredUsername || '').trim() || 'anon'
      let out = raw.slice(0, 20)
      if (out.length < 2) out = `${out}xx`.slice(0, 20)
      return out
    } catch {
      return `anon${10 + Math.floor(Math.random() * 89)}`
    }
  }

  /**
   * @param {import('socket.io').Socket} socket
   * @param {string} username
   * @returns {Promise<boolean>}
   */
  async function enqueueSocket(socket, username) {
    const trimmed = typeof username === 'string' ? username.trim() : ''
    if (trimmed.length < 2 || trimmed.length > 20) {
      socket.emit('queue_error', { message: 'Invalid username for queue.' })
      return false
    }
    if (socket.data.inQueue) {
      socket.emit('queue_error', { message: 'Already in queue.' })
      return false
    }
    const collegeId = socket.data.collegeId
    const userId = socket.data.userId
    if (!collegeId || !userId) {
      socket.emit('queue_error', { message: 'Missing session.' })
      return false
    }

    try {
      const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { freeVideoChatBanUntil: true, isBanned: true, banExpiresAt: true },
      })
      const moderationBanned =
        Boolean(userRow?.isBanned) &&
        (!userRow?.banExpiresAt || userRow.banExpiresAt > new Date())
      if (moderationBanned) {
        socket.emit('queue_error', {
          message:
            'Your account is currently restricted. Check your email for details, or contact support if you believe this is a mistake.',
          code: 'ACCOUNT_BANNED',
          ban_until: userRow?.banExpiresAt ? userRow.banExpiresAt.toISOString() : null,
        })
        return false
      }

      const banUntil = userRow?.freeVideoChatBanUntil
      const banned = banUntil && banUntil > new Date()
      if (banned) {
        const unlocked = await consumePaidQueueUnlock(userId)
        if (!unlocked) {
          socket.emit('queue_error', {
            message:
              'Free video match is unavailable until your restriction ends. Pay ₹20 to start a session, or wait until the ban expires.',
            code: 'FREE_VIDEO_BAN',
            ban_until: banUntil.toISOString(),
            requires_payment: true,
          })
          return false
        }
      }
    } catch (e) {
      console.error('[matching] enqueue ban check:', e)
      socket.emit('queue_error', { message: 'Could not verify match eligibility.' })
      return false
    }

    const meta = {
      socketId: socket.id,
      userId,
      username: trimmed,
      collegeId,
      joinedAt: Date.now(),
    }
    try {
      if (!redis) {
        const q = memQueues.get(collegeId) || []
        q.push(meta)
        memQueues.set(collegeId, q)
        console.log('[matching] queued', {
          mode: 'memory',
          collegeId,
          socketId: socket.id,
          userId,
          queueLen: q.length,
        })
      } else {
        const queueKey = `${QUEUE_PREFIX}${collegeId}`
        await redis.rpush(queueKey, socket.id)
        await redis.set(`${SOCKET_META_PREFIX}${socket.id}`, JSON.stringify(meta))
        await redis.sadd(ACTIVE_COLLEGES_KEY, collegeId)
        const qlen = await redis.llen(queueKey)
        console.log('[matching] queued', {
          mode: 'redis',
          collegeId,
          socketId: socket.id,
          userId,
          queueLen: qlen,
        })
      }
      socket.data.inQueue = true
      socket.data.queueUsername = trimmed

      const timeout = setTimeout(async () => {
        queueTimeouts.delete(socket.id)
        if (!socket.data.inQueue) return
        try {
          await removeSocketFromQueue(collegeId, socket.id)
          socket.data.inQueue = false
          socket.emit('queue_timeout', { message: 'No match found within 60 seconds.' })
        } catch (e) {
          console.error('[matching] queue_timeout error:', e)
        }
      }, QUEUE_TIMEOUT_MS)
      queueTimeouts.set(socket.id, timeout)

      startMatcherLoop()
      socket.emit('joined_queue', { ok: true })
      return true
    } catch (e) {
      console.error('[matching] enqueue error:', e)
      socket.emit('queue_error', { message: 'Failed to join queue.' })
      return false
    }
  }

  async function tryMatchCollegeInMemory(collegeId) {
    const q = memQueues.get(collegeId) || []
    if (q.length < 2) return

    for (let i = 0; i < q.length; i += 1) {
      for (let j = i + 1; j < q.length; j += 1) {
        const A = q[i]
        const B = q[j]
        if (!(await canMatchPair(A, B))) continue

        // Remove matched pair from queue.
        const next = q.filter((e) => e.socketId !== A.socketId && e.socketId !== B.socketId)
        if (next.length) memQueues.set(collegeId, next)
        else memQueues.delete(collegeId)

        clearQueueTimeout(A.socketId)
        clearQueueTimeout(B.socketId)

        const roomId = crypto.randomUUID()
        const aIsOfferer = A.userId < B.userId
        const payloadA = {
          room_id: roomId,
          peer_username: B.username,
          peer_user_id: B.userId,
          is_offerer: aIsOfferer,
        }
        const payloadB = {
          room_id: roomId,
          peer_username: A.username,
          peer_user_id: A.userId,
          is_offerer: !aIsOfferer,
        }

        // Cooldown is Redis-backed; without Redis we skip this persistence.
        const sessionStartMs = Date.now()
        const matchRoom = {
          sockets: [A.socketId, B.socketId],
          userIds: [A.userId, B.userId],
          sessionStartMs,
          timers: [],
          hardEndTimer: null,
          extended: false,
          extensionState: null,
          dbSessionId: null,
          liveSessionEnded: false,
          cloakEngagedSeconds: {},
        }

        if (prisma) {
          try {
            const u1 = A.userId < B.userId ? A : B
            const u2 = A.userId < B.userId ? B : A
            const row = await prisma.session.create({
              data: {
                user1Id: u1.userId,
                user2Id: u2.userId,
                collegeId: collegeId,
                user1Username: u1.username.slice(0, 64),
                user2Username: u2.username.slice(0, 64),
                matchRoomId: roomId,
              },
            })
            matchRoom.dbSessionId = row.id
            payloadA.session_id = row.id
            payloadB.session_id = row.id
          } catch (e) {
            console.error('[matching] session create (mem):', e)
          }
        }

        activeMatchRooms.set(roomId, matchRoom)
        scheduleMatchRoomLifecycle(roomId)

        payloadA.session_start_at_ms = sessionStartMs
        payloadA.session_end_at_ms = sessionStartMs + SESSION_LIVE_MS
        payloadB.session_start_at_ms = sessionStartMs
        payloadB.session_end_at_ms = sessionStartMs + SESSION_LIVE_MS

        io.to(A.socketId).emit('match_found', payloadA)
        io.to(B.socketId).emit('match_found', payloadB)
        console.log('[matching] match_found', {
          roomId,
          collegeId,
          A: { socketId: A.socketId, userId: A.userId, username: A.username },
          B: { socketId: B.socketId, userId: B.userId, username: B.username },
          via: 'memory',
        })

        const sockA = io.sockets.sockets.get(A.socketId)
        const sockB = io.sockets.sockets.get(B.socketId)
        if (sockA) sockA.data.inQueue = false
        if (sockB) sockB.data.inQueue = false

        // Continue matching same college if more people are waiting.
        await tryMatchCollegeInMemory(collegeId)
        return
      }
    }
  }

  async function runMatchingTick() {
    if (DEBUG_MATCHING) {
      runMatchingTick._n = (runMatchingTick._n || 0) + 1
      if (runMatchingTick._n % 20 === 0) console.log('[matching] matcher_tick', { redis: Boolean(redis) })
    }
    if (!redis) {
      const colleges = [...memQueues.keys()]
      if (DEBUG_MATCHING) console.log('[matching] matcher_colleges', { count: colleges.length, colleges })
      for (const collegeId of colleges) {
        try {
          await tryMatchCollegeInMemory(collegeId)
        } catch (err) {
          console.error('[matching] tryMatchCollege (mem) error:', collegeId, err)
        }
      }
      return
    }
    const colleges = await redis.smembers(ACTIVE_COLLEGES_KEY)
    if (DEBUG_MATCHING) console.log('[matching] matcher_colleges', { count: colleges?.length || 0, colleges })
    if (!colleges?.length) return
    for (const collegeId of colleges) {
      try {
        await tryMatchCollege(collegeId)
      } catch (err) {
        console.error('[matching] tryMatchCollege error:', collegeId, err)
      }
    }
  }

  let intervalId = null
  function startMatcherLoop() {
    if (intervalId) return
    intervalId = setInterval(runMatchingTick, MATCH_INTERVAL_MS)
    console.log('[matching] matcher_loop_started', { intervalMs: MATCH_INTERVAL_MS, redis: Boolean(redis) })
  }

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (typeof socket.handshake.headers?.authorization === 'string'
        ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
        : null)
    if (!token) {
      return next(new Error('Unauthorized'))
    }
    try {
      const payload = jwt.verify(token, accessTokenSecret)
      const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
      socket.data.userId = payload.sub
      socket.data.collegeId =
        email && TEST_MATCH_EMAILS.has(email) ? TEST_COLLEGE_ID : payload.collegeId
      socket.data.inQueue = false
      return next()
    } catch {
      return next(new Error('Unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    socket.emit('connected', { message: 'Socket connected' })

    socket.on('join_queue', async (payload) => {
      const username = typeof payload?.username === 'string' ? payload.username.trim() : ''
      console.log('[matching] join_queue', {
        socketId: socket.id,
        userId: socket.data?.userId,
        collegeId: socket.data?.collegeId,
      })
      await enqueueSocket(socket, username)
    })

    socket.on('skip_match', async (payload) => {
      try {
        const roomId = payload?.room_id
        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('skip_error', { message: 'room_id required.' })
        }
        const room = activeMatchRooms.get(roomId)
        if (!room || !room.sockets.includes(socket.id)) {
          return socket.emit('skip_error', { message: 'Invalid or expired room.' })
        }

        const skipperUserId = socket.data.userId
        if (!skipperUserId) {
          return socket.emit('skip_error', { message: 'Missing session.' })
        }

        const rate = await checkSkipRateLimit(skipperUserId)
        if (rate.locked) {
          return socket.emit('skip_rate_limited', {
            message:
              "You've reached the skip limit (30 per hour). Next is locked for 10 minutes. Try again in a few minutes.",
            locked_until_ms: rate.lockedUntilMs ?? Date.now() + SKIP_LOCK_SEC * 1000,
          })
        }

        await recordSkipForUser(skipperUserId)

        const otherId = room.sockets.find((id) => id !== socket.id)
        const dbSessionIdSkip = room.dbSessionId
        const sessionStartMsSkip = room.sessionStartMs
        const { u1: engU1, u2: engU2 } = getEngagementSnapshot(room)

        if (dbSessionIdSkip && prisma) {
          try {
            const sess = await prisma.session.findUnique({
              where: { id: dbSessionIdSkip },
              select: { user1Id: true, user2Id: true },
            })
            /** @type {Record<string, unknown>} */
            const data = {
              user1EngagedSeconds: engU1,
              user2EngagedSeconds: engU2,
              endedAt: new Date(),
              durationSeconds: Math.max(0, Math.floor((Date.now() - sessionStartMsSkip) / 1000)),
              endReason: 'next_skip',
            }
            if (sess) {
              if (skipperUserId === sess.user1Id) data.user1PressedNext = true
              else if (skipperUserId === sess.user2Id) data.user2PressedNext = true
            }
            await prisma.session.update({
              where: { id: dbSessionIdSkip },
              data,
            })
            cloakQueue?.enqueueSessionRewards(dbSessionIdSkip)
          } catch (e) {
            console.error('[matching] skip session update:', e)
          }
        }

        clearPostSessionTimer(roomId)
        clearRoomTimers(room)
        activeMatchRooms.delete(roomId)
        socket.data.matchRoomId = undefined

        const otherSocket = otherId ? io.sockets.sockets.get(otherId) : null
        if (otherSocket) {
          otherSocket.data.matchRoomId = undefined
        }

        const otherMsg = 'Your match has moved on — finding you a new connection...'

        if (otherSocket) {
          otherSocket.emit('peer_moved_on', { message: otherMsg })
        }

        socket.emit('skip_accepted', { ok: true })

        const uSkipper = await resolveQueueUsername(socket)
        const uPeer = otherSocket ? await resolveQueueUsername(otherSocket) : null

        await enqueueSocket(socket, uSkipper)
        if (otherSocket) {
          await enqueueSocket(otherSocket, uPeer || uSkipper)
        }
      } catch (e) {
        console.error('[matching] skip_match error:', e)
        socket.emit('skip_error', { message: 'Could not skip to next match.' })
      }
    })

    socket.on('leave_queue', async () => {
      if (!redis || !socket.data.inQueue || !socket.data.collegeId) return
      await removeSocketFromQueue(socket.data.collegeId, socket.id)
      socket.data.inQueue = false
    })

    socket.on('join_match_room', ({ room_id: roomId }) => {
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('room_error', { message: 'room_id required.' })
      }
      const room = activeMatchRooms.get(roomId)
      if (!room || !room.sockets.includes(socket.id)) {
        return socket.emit('room_error', { message: 'Invalid or expired room.' })
      }
      socket.data.matchRoomId = roomId
    })

    /** CloakScore: client sends engaged seconds per tick (max +5s); idle detection is client-side */
    socket.on('cloak_engagement_delta', (payload) => {
      const roomId = payload?.room_id
      const delta = Number(payload?.delta_seconds)
      if (!roomId || typeof roomId !== 'string') return
      if (!Number.isFinite(delta) || delta <= 0) return
      const room = activeMatchRooms.get(roomId)
      if (!room || !room.sockets.includes(socket.id)) return
      const userId = socket.data.userId
      if (!userId) return
      const capped = Math.min(5, delta)
      if (!room.cloakEngagedSeconds) room.cloakEngagedSeconds = {}
      const prev = room.cloakEngagedSeconds[userId] || 0
      room.cloakEngagedSeconds[userId] = Math.min(7 * 60, prev + capped)
    })

    socket.on('webrtc_offer', (data) => {
      const { room_id: roomId, sdp } = data || {}
      if (!roomId || !sdp) return
      relayToPeer(socket, roomId, 'webrtc_offer_relay', { room_id: roomId, sdp })
    })

    socket.on('webrtc_answer', (data) => {
      const { room_id: roomId, sdp } = data || {}
      if (!roomId || !sdp) return
      relayToPeer(socket, roomId, 'webrtc_answer_relay', { room_id: roomId, sdp })
    })

    socket.on('ice_candidate', (data) => {
      const { room_id: roomId, candidate } = data || {}
      if (!roomId || candidate == null) return
      relayToPeer(socket, roomId, 'ice_candidate_relay', { room_id: roomId, candidate })
    })

    socket.on('chat_history_request', async ({ room_id: roomId }) => {
      try {
        if (!roomId || typeof roomId !== 'string') return
        const room = activeMatchRooms.get(roomId)
        if (!room || !room.sockets.includes(socket.id)) {
          return socket.emit('chat_error', { message: 'Invalid room.' })
        }
        const rows = await prisma.videoChatMessage.findMany({
          where: { matchRoomId: roomId },
          orderBy: { sentAt: 'asc' },
          take: 500,
        })
        socket.emit('chat_history', {
          room_id: roomId,
          messages: rows.map((r) => ({
            id: r.id,
            text: r.content,
            sender_username: r.senderUsername,
            sender_user_id: r.senderId,
            sent_at: r.sentAt.toISOString(),
            phase: r.phase,
          })),
        })
      } catch (e) {
        console.error('[matching] chat_history_request error:', e)
      }
    })

    socket.on('chat_message', async (payload) => {
      try {
        const roomId = payload?.room_id
        const text = typeof payload?.text === 'string' ? payload.text : ''
        const phase = payload?.phase === 'post_session' ? 'post_session' : 'live'
        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('chat_error', { message: 'room_id required.' })
        }
        const room = activeMatchRooms.get(roomId)
        if (!room || !room.sockets.includes(socket.id)) {
          return socket.emit('chat_error', { message: 'Invalid room.' })
        }
        if (phase === 'post_session') {
          if (!postSessionTimers.has(roomId)) {
            return socket.emit('chat_error', { message: 'Post-session chat is not active.' })
          }
        }

        if (phase === 'live' && room.liveSessionEnded) {
          return socket.emit('chat_error', { message: 'Live chat closed — rate the session or use post-session chat when it opens.' })
        }

        const n = countGraphemes(text)
        if (n < 1 || n > CHAT_MAX_GRAPHEMES) {
          return socket.emit('chat_error', {
            message: `Message must be 1–${CHAT_MAX_GRAPHEMES} characters.`,
          })
        }

        const userId = socket.data.userId
        if (!userId) {
          return socket.emit('chat_error', { message: 'Missing session.' })
        }

        if (phase === 'post_session') {
          const cnt = await prisma.videoChatMessage.count({
            where: { matchRoomId: roomId, senderId: userId, phase: 'post_session' },
          })
          if (cnt >= 2) {
            return socket.emit('chat_error', { message: 'Post-session limit reached (2 messages).' })
          }
        }

        const senderUsername = await resolveQueueUsername(socket)
        const row = await prisma.videoChatMessage.create({
          data: {
            matchRoomId: roomId,
            senderId: userId,
            senderUsername,
            content: text,
            phase,
          },
        })

        const out = {
          id: row.id,
          room_id: roomId,
          text: row.content,
          sender_username: row.senderUsername,
          sender_user_id: userId,
          sent_at: row.sentAt.toISOString(),
          phase: row.phase,
        }
        broadcastToMatchRoom(roomId, 'chat_message_relay', out)
      } catch (e) {
        console.error('[matching] chat_message error:', e)
        socket.emit('chat_error', { message: 'Could not send message.' })
      }
    })

    socket.on('chat_typing', (payload) => {
      const roomId = payload?.room_id
      if (!roomId || typeof roomId !== 'string') return
      relayToPeer(socket, roomId, 'chat_typing_relay', { room_id: roomId })
    })

    socket.on('chat_typing_stop', (payload) => {
      const roomId = payload?.room_id
      if (!roomId || typeof roomId !== 'string') return
      relayToPeer(socket, roomId, 'chat_typing_stop_relay', { room_id: roomId })
    })

    socket.on('session_end_natural', async ({ room_id: roomId }) => {
      try {
        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('session_error', { message: 'room_id required.' })
        }
        const room = activeMatchRooms.get(roomId)
        if (!room || !room.sockets.includes(socket.id)) {
          return socket.emit('session_error', { message: 'Invalid room.' })
        }
        if (postSessionTimers.has(roomId)) {
          const exp = postSessionExpiryMs.get(roomId)
          if (typeof exp === 'number') {
            socket.emit('post_session_started', { room_id: roomId, expires_at_ms: exp })
          }
          return
        }
        if (room.ratingPhase?.active) {
          const peerSid = room.sockets.find((id) => id !== socket.id)
          const peerSock = peerSid ? io.sockets.sockets.get(peerSid) : null
          const peerUsername = peerSock ? await resolveQueueUsername(peerSock) : 'Peer'
          socket.emit('rating_phase_started', {
            room_id: roomId,
            session_id: room.dbSessionId,
            peer_username: peerUsername,
            deadline_ms: room.ratingPhase.deadlineMs,
          })
          return
        }

        await beginRatingPhase(roomId)
      } catch (e) {
        console.error('[matching] session_end_natural error:', e)
        socket.emit('session_error', { message: 'Could not start post-session chat.' })
      }
    })

    socket.on('session_submit_rating', async (payload) => {
      try {
        const roomId = payload?.room_id
        const sessionId = payload?.session_id
        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('rating_error', { message: 'room_id required.' })
        }
        const room = activeMatchRooms.get(roomId)
        if (!room || !room.sockets.includes(socket.id)) {
          return socket.emit('rating_error', { message: 'Invalid room.' })
        }
        if (!room.ratingPhase?.active) {
          return socket.emit('rating_error', { message: 'Rating is not active for this room.' })
        }
        if (!room.dbSessionId || room.dbSessionId !== sessionId) {
          return socket.emit('rating_error', { message: 'Invalid session.' })
        }
        const userId = socket.data.userId
        if (!userId) {
          return socket.emit('rating_error', { message: 'Missing session.' })
        }
        if (room.ratingPhase.submitted.has(userId)) {
          return socket.emit('rating_error', { message: 'You already submitted a rating.' })
        }
        const stars = Number(payload?.stars)
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
          return socket.emit('rating_error', { message: 'Please choose 1–5 stars.' })
        }
        const rawFb = typeof payload?.feedback === 'string' ? payload.feedback.trim().slice(0, 2000) : ''
        const feedback = rawFb.length > 0 ? rawFb : null

        const sess = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { user1Id: true, user2Id: true },
        })
        if (!sess) {
          return socket.emit('rating_error', { message: 'Session not found.' })
        }
        /** @type {Record<string, unknown>} */
        const data = {}
        if (userId === sess.user1Id) {
          data.user1Rating = stars
          data.user1Feedback = feedback
        } else if (userId === sess.user2Id) {
          data.user2Rating = stars
          data.user2Feedback = feedback
        } else {
          return socket.emit('rating_error', { message: 'You are not part of this session.' })
        }
        await prisma.session.update({ where: { id: sessionId }, data })

        room.ratingPhase.submitted.add(userId)
        socket.emit('rating_submitted', { ok: true })
        if (room.ratingPhase.submitted.size >= 2) {
          finishRatingPhase(roomId)
        }
      } catch (e) {
        console.error('[matching] session_submit_rating error:', e)
        socket.emit('rating_error', { message: 'Could not save rating.' })
      }
    })

    socket.on('disconnect', async () => {
      clearQueueTimeout(socket.id)
      await handleDisconnect(socket)
      removeSocketFromMatchRooms(socket)
    })
  })

  /**
   * Moderation: disconnect all sockets for a user (ends match presence) and notify client.
   * @param {string} userId
   * @param {any} payload
   */
  function forceDisconnectUserForModeration(userId, payload) {
    if (!userId) return
    try {
      for (const s of io.sockets.sockets.values()) {
        if (s?.data?.userId !== userId) continue
        try {
          s.emit('account_banned', payload || { message: 'Your account has been restricted.' })
        } catch {
          // ignore
        }
        try {
          s.disconnect(true)
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('[matching] forceDisconnectUserForModeration error:', e)
    }
  }

  return {
    runMatchingTick,
    startMatcherLoop,
    verifyExtensionPayment,
    createQueueUnlockOrder,
    verifyQueueUnlockPayment,
    forceDisconnectUserForModeration,
  }
}

module.exports = {
  createMatchingService,
  QUEUE_TIMEOUT_MS,
  MATCH_INTERVAL_MS,
  SKIP_MAX_PER_WINDOW,
  SKIP_LOCK_SEC,
}
