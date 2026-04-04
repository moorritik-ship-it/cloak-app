const crypto = require('crypto')
const { Prisma } = require('@prisma/client')
const {
  hashWalletPin,
  verifyWalletPin,
  validatePinFormat,
  tryAwardWalletMilestonesAndNotify,
} = require('./walletService')

const extensionPaymentMock =
  process.env.EXTENSION_PAYMENT_MOCK === 'true' || process.env.EXTENSION_PAYMENT_MOCK === '1'

let RazorpayCtor = null
try {
  RazorpayCtor = require('razorpay')
} catch {
  /* optional */
}

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || ''
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || ''

let razorpayInstance = null
if (RazorpayCtor && razorpayKeyId && razorpayKeySecret && !extensionPaymentMock) {
  try {
    razorpayInstance = new RazorpayCtor({ key_id: razorpayKeyId, key_secret: razorpayKeySecret })
  } catch (e) {
    console.error('[wallet] Razorpay init failed:', e?.message)
  }
}

/** @type {Map<string, { userId: string, amountPaise: number, expiresAt: number }>} */
const walletTopupByOrderId = new Map()

const TOPUP_MIN_INR = 10
const TOPUP_MAX_INR = 50_000
const WITHDRAW_MIN_INR = 100
const ORDER_TTL_MS = 30 * 60 * 1000

function paymentsConfigured() {
  return Boolean(extensionPaymentMock || razorpayInstance)
}

function sweepExpiredTopups() {
  const now = Date.now()
  for (const [k, v] of walletTopupByOrderId) {
    if (v.expiresAt < now) walletTopupByOrderId.delete(k)
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ prisma: import('@prisma/client').PrismaClient, getUserIdFromBearer: (req: import('express').Request) => string | null }} ctx
 */
function registerWalletApi(app, { prisma, getUserIdFromBearer }) {
  app.get('/api/wallet', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      await tryAwardWalletMilestonesAndNotify(prisma, userId).catch(() => {})

      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          walletBalance: true,
          walletPinHash: true,
          walletPinSalt: true,
        },
      })
      if (!user) return res.status(404).json({ message: 'User not found.' })

      const txs = await prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          amount: true,
          reason: true,
          type: true,
          createdAt: true,
        },
      })

      return res.status(200).json({
        balance: user.walletBalance?.toString() || '0',
        hasWalletPin: Boolean(user.walletPinHash && user.walletPinSalt),
        transactions: txs.map((t) => ({
          id: t.id,
          amount: t.amount.toString(),
          reason: t.reason,
          type: t.type,
          createdAt: t.createdAt.toISOString(),
        })),
      })
    } catch (e) {
      console.error('/api/wallet error:', e)
      return res.status(500).json({ message: 'Failed to load wallet.' })
    }
  })

  app.post('/api/wallet/set-pin', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const { pin, pinConfirm } = req.body || {}
      if (!validatePinFormat(pin) || pin !== pinConfirm) {
        return res.status(400).json({ message: 'PIN must be 4–6 digits and match confirmation.' })
      }

      const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletPinHash: true },
      })
      if (existing?.walletPinHash) {
        return res.status(400).json({ message: 'Wallet PIN is already set.' })
      }

      const { salt, hashHex } = hashWalletPin(pin)
      await prisma.user.update({
        where: { id: userId },
        data: { walletPinSalt: salt, walletPinHash: hashHex },
      })

      return res.status(200).json({ ok: true, hasWalletPin: true })
    } catch (e) {
      console.error('/api/wallet/set-pin error:', e)
      return res.status(500).json({ message: 'Failed to set PIN.' })
    }
  })

  app.post('/api/wallet/topup-order', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const rupees = Number((req.body || {}).amountInr)
      if (!Number.isFinite(rupees) || rupees < TOPUP_MIN_INR || rupees > TOPUP_MAX_INR) {
        return res.status(400).json({
          message: `Amount must be between ₹${TOPUP_MIN_INR} and ₹${TOPUP_MAX_INR}.`,
        })
      }

      if (!paymentsConfigured()) {
        return res.status(503).json({
          message:
            'Wallet top-up is not configured (set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET or EXTENSION_PAYMENT_MOCK=true).',
        })
      }

      const amountPaise = Math.round(rupees * 100)
      if (amountPaise < 1000) {
        return res.status(400).json({ message: 'Minimum top-up is ₹10.' })
      }

      sweepExpiredTopups()

      let orderId = `mock_wt_${userId}_${Date.now()}`
      if (!extensionPaymentMock && razorpayInstance) {
        const order = await razorpayInstance.orders.create({
          amount: amountPaise,
          currency: 'INR',
          receipt: `wt${crypto.randomBytes(8).toString('hex')}`.slice(0, 40),
          notes: { type: 'wallet_topup', user_id: userId },
        })
        orderId = order.id
      }

      walletTopupByOrderId.set(orderId, {
        userId,
        amountPaise,
        expiresAt: Date.now() + ORDER_TTL_MS,
      })

      return res.status(200).json({
        order_id: orderId,
        amount_paise: amountPaise,
        currency: 'INR',
        razorpay_key_id: razorpayKeyId,
      })
    } catch (e) {
      console.error('/api/wallet/topup-order error:', e)
      return res.status(500).json({ message: 'Failed to create top-up order.' })
    }
  })

  app.post('/api/wallet/topup-verify', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
      if (!razorpay_order_id || !razorpay_payment_id) {
        return res.status(400).json({ message: 'Missing payment fields.' })
      }

      sweepExpiredTopups()
      const pending = walletTopupByOrderId.get(razorpay_order_id)
      if (!pending || pending.userId !== userId) {
        return res.status(400).json({ message: 'Invalid or expired top-up order.' })
      }
      if (Date.now() > pending.expiresAt) {
        walletTopupByOrderId.delete(razorpay_order_id)
        return res.status(400).json({ message: 'Top-up order expired. Create a new one.' })
      }

      const isMockOrder = String(razorpay_order_id).startsWith('mock_wt_')
      const allowDevMock = extensionPaymentMock || (!razorpayKeySecret && isMockOrder)
      if (allowDevMock) {
        if (!isMockOrder) {
          return res.status(400).json({ message: 'Invalid mock top-up order.' })
        }
      } else {
        if (!razorpayKeySecret) {
          return res.status(503).json({ message: 'Payments are not configured on the server.' })
        }
        const expected = crypto
          .createHmac('sha256', razorpayKeySecret)
          .update(`${razorpay_order_id}|${razorpay_payment_id}`)
          .digest('hex')
        if (expected !== String(razorpay_signature || '')) {
          return res.status(400).json({ message: 'Invalid payment signature.' })
        }
      }

      const recentTopups = await prisma.walletTransaction.findMany({
        where: { userId, type: 'topup' },
        orderBy: { createdAt: 'desc' },
        take: 80,
        select: { id: true, metadata: true },
      })
      const existing = recentTopups.find((t) => t.metadata?.razorpayPaymentId === razorpay_payment_id)
      if (existing) {
        walletTopupByOrderId.delete(razorpay_order_id)
        const u = await prisma.user.findUnique({
          where: { id: userId },
          select: { walletBalance: true },
        })
        return res.status(200).json({ ok: true, already: true, balance: u?.walletBalance?.toString() || '0' })
      }

      const creditInr = new Prisma.Decimal(pending.amountPaise).dividedBy(100)

      await prisma.$transaction(async (tx) => {
        await tx.walletTransaction.create({
          data: {
            userId,
            amount: creditInr,
            reason: 'Wallet top-up (Razorpay)',
            type: 'topup',
            metadata: {
              razorpayOrderId: razorpay_order_id,
              razorpayPaymentId: razorpay_payment_id,
            },
          },
        })
        await tx.user.update({
          where: { id: userId },
          data: { walletBalance: { increment: creditInr } },
        })
      })

      walletTopupByOrderId.delete(razorpay_order_id)

      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletBalance: true },
      })

      return res.status(200).json({
        ok: true,
        balance: u?.walletBalance?.toString() || '0',
      })
    } catch (e) {
      console.error('/api/wallet/topup-verify error:', e)
      return res.status(500).json({ message: 'Failed to verify top-up.' })
    }
  })

  app.post('/api/wallet/withdraw', async (req, res) => {
    try {
      const userId = getUserIdFromBearer(req)
      if (!userId) return res.status(401).json({ message: 'Unauthorized.' })

      const { amountInr, upiId, pin } = req.body || {}
      const amt = Number(amountInr)
      if (!Number.isFinite(amt) || amt < WITHDRAW_MIN_INR) {
        return res.status(400).json({ message: `Minimum withdrawal is ₹${WITHDRAW_MIN_INR}.` })
      }

      const upi = String(upiId || '').trim().toLowerCase()
      if (!/^[a-z0-9._-]{2,50}@[a-z0-9]{2,20}$/i.test(upi)) {
        return res.status(400).json({ message: 'Enter a valid UPI ID (e.g. name@paytm).' })
      }

      if (!validatePinFormat(pin)) {
        return res.status(400).json({ message: 'Enter your 4–6 digit wallet PIN.' })
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          walletBalance: true,
          walletPinHash: true,
          walletPinSalt: true,
        },
      })
      if (!user?.walletPinHash || !user.walletPinSalt) {
        return res.status(400).json({ message: 'Set a wallet PIN in Profile before withdrawing.' })
      }
      if (!verifyWalletPin(pin, user.walletPinSalt, user.walletPinHash)) {
        return res.status(401).json({ message: 'Incorrect wallet PIN.' })
      }

      const balance = new Prisma.Decimal(user.walletBalance || 0)
      const debit = new Prisma.Decimal(String(amt))
      if (balance.lessThan(debit)) {
        return res.status(400).json({ message: 'Insufficient wallet balance.' })
      }

      const negAmt = new Prisma.Decimal(String(-amt))

      await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUnique({
          where: { id: userId },
          select: { walletBalance: true },
        })
        const b = new Prisma.Decimal(fresh?.walletBalance || 0)
        if (b.lessThan(debit)) {
          throw new Error('INSUFFICIENT')
        }
        await tx.walletTransaction.create({
          data: {
            userId,
            amount: negAmt,
            reason: `Withdrawal to UPI: ${upi}`,
            type: 'withdrawal',
            metadata: { upiId: upi, amountInr: amt },
          },
        })
        await tx.user.update({
          where: { id: userId },
          data: { walletBalance: { increment: negAmt } },
        })
      })

      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletBalance: true },
      })

      return res.status(200).json({
        ok: true,
        balance: u?.walletBalance?.toString() || '0',
      })
    } catch (e) {
      if (e?.message === 'INSUFFICIENT') {
        return res.status(400).json({ message: 'Insufficient wallet balance.' })
      }
      console.error('/api/wallet/withdraw error:', e)
      return res.status(500).json({ message: 'Withdrawal failed.' })
    }
  })
}

module.exports = { registerWalletApi }
