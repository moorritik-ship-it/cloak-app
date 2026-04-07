import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion as Motion } from 'framer-motion'
import LoginParticles from '../components/LoginParticles'
import { setAuthSession } from '../utils/authStorage'
import { isLoginEmailAllowed, normalizeEmailForLogin } from '../utils/loginEmail'
import { apiUrl } from '../utils/apiBase'

const OTP_LENGTH = 6
const TIMER_SECONDS = 5 * 60

const otpContainerVariants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.06,
    },
  },
}

const otpItemVariants = {
  hidden: { opacity: 0, x: -22, scale: 0.65 },
  show: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 520,
      damping: 14,
      mass: 0.55,
    },
  },
}

const pulseShadow = [
  '0 0 0 1px rgba(124, 58, 237, 0.38), 0 0 22px rgba(124, 58, 237, 0.32)',
  '0 0 0 1px rgba(124, 58, 237, 0.62), 0 0 38px rgba(124, 58, 237, 0.52), 0 0 52px rgba(6, 182, 212, 0.22)',
  '0 0 0 1px rgba(124, 58, 237, 0.38), 0 0 22px rgba(124, 58, 237, 0.32)',
]

function ButtonSpinner() {
  return (
    <Motion.span
      className="login-btn-spinner"
      animate={{ rotate: 360 }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      aria-hidden
    />
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [step, setStep] = useState(1)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [isRequestingOtp, setIsRequestingOtp] = useState(false)
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false)
  const [isResendingOtp, setIsResendingOtp] = useState(false)
  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''))
  const [secondsLeft, setSecondsLeft] = useState(TIMER_SECONDS)
  const otpInputRefs = useRef([])

  useEffect(() => {
    if (step !== 2) {
      return undefined
    }

    const intervalId = setInterval(() => {
      setSecondsLeft((currentValue) => {
        if (currentValue <= 1) {
          clearInterval(intervalId)
          return 0
        }
        return currentValue - 1
      })
    }, 1000)

    return () => clearInterval(intervalId)
  }, [step])

  const formatTimer = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  const requestOtp = async (submittedEmail) => {
    const response = await fetch(apiUrl('/auth/request-otp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: submittedEmail }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data?.message || 'Failed to request OTP.')
    }

    return data
  }

  const verifyOtp = async (submittedEmail, submittedOtp) => {
    const response = await fetch(apiUrl('/auth/verify-otp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: submittedEmail, otp: submittedOtp }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const hint = data?.detail ? ` ${data.detail}` : ''
      throw new Error((data?.message || 'Failed to verify OTP.') + hint)
    }

    return data
  }

  const handleSubmitEmail = async (event) => {
    event.preventDefault()
    const normalizedEmail = normalizeEmailForLogin(email)

    setErrorMessage('')
    setSuccessMessage('')

    if (!isLoginEmailAllowed(normalizedEmail)) {
      setErrorMessage('Invalid college email format.')
      return
    }

    try {
      setIsRequestingOtp(true)
      const data = await requestOtp(normalizedEmail)

      setSuccessMessage(data?.message || 'OTP sent.')
      setStep(2)
      setSecondsLeft(TIMER_SECONDS)
      setOtp(Array(OTP_LENGTH).fill(''))
    } catch (error) {
      setErrorMessage(error?.message || 'Failed to request OTP.')
    } finally {
      setIsRequestingOtp(false)
    }
  }

  const handleOtpChange = (index, value) => {
    const nextValue = value.replace(/\D/g, '').slice(0, 1)
    const nextOtp = [...otp]
    nextOtp[index] = nextValue
    setOtp(nextOtp)

    if (nextValue && index < OTP_LENGTH - 1) {
      otpInputRefs.current[index + 1]?.focus()
    }
  }

  const handleOtpKeyDown = (index, event) => {
    if (event.key === 'Backspace' && !otp[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus()
    }
  }

  const handleOtpSubmit = async (event) => {
    event.preventDefault()

    const otpValue = otp.join('')
    if (otpValue.length !== OTP_LENGTH) return

    const normalizedEmail = normalizeEmailForLogin(email)
    if (!isLoginEmailAllowed(normalizedEmail)) {
      setErrorMessage('Invalid college email format.')
      return
    }

    setErrorMessage('')
    setSuccessMessage('')

    try {
      setIsVerifyingOtp(true)
      const data = await verifyOtp(normalizedEmail, otpValue)
      if (data?.accessToken && data?.user) {
        setAuthSession(data.accessToken, data.user)
      }
      navigate('/dashboard', { replace: true })
    } catch (error) {
      setErrorMessage(error?.message || 'OTP verification failed.')
    } finally {
      setIsVerifyingOtp(false)
    }
  }

  const handleResendOtp = async () => {
    const normalizedEmail = normalizeEmailForLogin(email)
    setErrorMessage('')
    setSuccessMessage('')

    if (!isLoginEmailAllowed(normalizedEmail)) {
      setErrorMessage('Invalid college email format.')
      return
    }

    try {
      setIsResendingOtp(true)
      const data = await requestOtp(normalizedEmail)
      setSuccessMessage(data?.message || 'OTP resent.')
      setOtp(Array(OTP_LENGTH).fill(''))
      setSecondsLeft(TIMER_SECONDS)
      otpInputRefs.current[0]?.focus()
    } catch (error) {
      setErrorMessage(error?.message || 'Failed to resend OTP.')
    } finally {
      setIsResendingOtp(false)
    }
  }

  return (
    <Motion.main
      className="simple-page login-page min-h-dvh w-full min-w-0 max-w-[100vw] overflow-x-hidden px-0 text-base md:mx-auto md:min-h-0 md:max-w-[1040px] md:px-4 md:py-10 lg:py-12"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <div className="login-page-stack flex w-full min-w-0 max-w-full flex-col items-center gap-4 px-3 sm:px-4 md:max-w-[540px] md:gap-5 md:px-0">
        <LoginParticles />

        <Motion.div
          className="login-brand-logo text-3xl sm:text-4xl md:text-5xl"
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
        >
          CLOAK
        </Motion.div>

        <Motion.section
          className="simple-card login-page-card w-full min-w-0 max-w-full rounded-none border-x-0 md:max-w-lg md:rounded-2xl md:border-x"
          initial={{ opacity: 0, y: 72 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            type: 'spring',
            damping: 26,
            stiffness: 220,
            mass: 0.88,
            delay: 0.12,
          }}
        >
          <h1 className="login-card-title text-lg sm:text-xl md:text-2xl">Login to CLOAK</h1>
          {step === 1 ? (
            <form onSubmit={handleSubmitEmail} className="login-form">
              <Motion.input
                type="text"
                value={email}
                required
                onChange={(event) => setEmail(event.target.value)}
                placeholder="College .ac.in email or moorritik@gmail.com / moorritik6@gmail.com"
                autoComplete="email"
                className="login-email-input min-h-12 w-full text-base sm:text-[0.95rem]"
                whileFocus={{
                  boxShadow:
                    '0 0 0 3px rgba(124, 58, 237, 0.42), 0 0 28px rgba(124, 58, 237, 0.38), 0 0 48px rgba(6, 182, 212, 0.12)',
                  borderColor: 'rgba(124, 58, 237, 0.75)',
                }}
                transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              />
              <AnimatePresence mode="wait">
                {errorMessage ? (
                  <Motion.p
                    key={errorMessage}
                    className="form-error text-sm leading-snug sm:text-base"
                    role="alert"
                    initial={{ opacity: 0, x: 0 }}
                    animate={{
                      opacity: 1,
                      x: [0, -12, 12, -10, 10, -6, 6, -3, 3, 0],
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.18 } }}
                    transition={{
                      opacity: { duration: 0.2 },
                      x: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
                    }}
                  >
                    {errorMessage}
                  </Motion.p>
                ) : null}
              </AnimatePresence>
              <AnimatePresence>
                {successMessage ? (
                  <Motion.p
                    key={successMessage}
                    className="form-success text-sm sm:text-base"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    {successMessage}
                  </Motion.p>
                ) : null}
              </AnimatePresence>
              <Motion.button
                type="submit"
                className="cta-button cta-primary login-primary-cta min-h-12 w-full text-base sm:min-h-[3.25rem]"
                disabled={isRequestingOtp}
                animate={
                  isRequestingOtp
                    ? { boxShadow: '0 0 0 1px rgba(124, 58, 237, 0.35), 0 0 20px rgba(124, 58, 237, 0.25)' }
                    : { boxShadow: pulseShadow }
                }
                transition={
                  isRequestingOtp
                    ? { duration: 0.25 }
                    : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
                }
                whileHover={isRequestingOtp ? {} : { scale: 1.045 }}
                whileTap={isRequestingOtp ? {} : { scale: 0.98 }}
              >
                {isRequestingOtp ? (
                  <>
                    <ButtonSpinner />
                    Sending OTP...
                  </>
                ) : (
                  'Login with College ID'
                )}
              </Motion.button>
            </form>
          ) : (
            <form onSubmit={handleOtpSubmit} className="login-form">
              <Motion.div
                key="otp-row"
                className="otp-row w-full min-w-0"
                aria-label="OTP input"
                variants={otpContainerVariants}
                initial="hidden"
                animate="show"
              >
                {otp.map((digit, index) => (
                  <Motion.input
                    key={index}
                    ref={(element) => {
                      otpInputRefs.current[index] = element
                    }}
                    className="otp-box min-h-12 min-w-0 text-lg sm:text-xl"
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    variants={otpItemVariants}
                    onChange={(event) => handleOtpChange(index, event.target.value)}
                    onKeyDown={(event) => handleOtpKeyDown(index, event)}
                    whileFocus={{
                      boxShadow:
                        '0 0 0 3px rgba(124, 58, 237, 0.35), 0 0 18px rgba(124, 58, 237, 0.28)',
                      borderColor: 'rgba(124, 58, 237, 0.65)',
                    }}
                    transition={{ type: 'spring', stiffness: 400, damping: 26 }}
                  />
                ))}
              </Motion.div>

              <div className="otp-meta flex-wrap text-sm sm:text-base">
                <span>Expires in {formatTimer(secondsLeft)}</span>
                <Motion.button
                  type="button"
                  className="resend-btn min-h-12 px-3 text-sm font-bold sm:text-base"
                  onClick={handleResendOtp}
                  disabled={isResendingOtp}
                  whileHover={isResendingOtp ? {} : { scale: 1.03 }}
                  whileTap={isResendingOtp ? {} : { scale: 0.98 }}
                >
                  {isResendingOtp ? (
                    <>
                      <ButtonSpinner />
                      Sending...
                    </>
                  ) : (
                    'Resend OTP'
                  )}
                </Motion.button>
              </div>

              <AnimatePresence mode="wait">
                {errorMessage ? (
                  <Motion.p
                    key={errorMessage}
                    className="form-error text-sm leading-snug sm:text-base"
                    role="alert"
                    initial={{ opacity: 0, x: 0 }}
                    animate={{
                      opacity: 1,
                      x: [0, -12, 12, -10, 10, -6, 6, -3, 3, 0],
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.18 } }}
                    transition={{
                      opacity: { duration: 0.2 },
                      x: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
                    }}
                  >
                    {errorMessage}
                  </Motion.p>
                ) : null}
              </AnimatePresence>
              <AnimatePresence>
                {successMessage ? (
                  <Motion.p
                    key={successMessage}
                    className="form-success text-sm sm:text-base"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    {successMessage}
                  </Motion.p>
                ) : null}
              </AnimatePresence>

              <Motion.button
                type="submit"
                className="cta-button cta-primary login-verify-cta min-h-12 w-full text-base sm:min-h-[3.25rem]"
                disabled={isVerifyingOtp}
                whileHover={isVerifyingOtp ? {} : { scale: 1.045 }}
                whileTap={isVerifyingOtp ? {} : { scale: 0.98 }}
              >
                {isVerifyingOtp ? (
                  <>
                    <ButtonSpinner />
                    Verifying...
                  </>
                ) : (
                  'Verify OTP'
                )}
              </Motion.button>
            </form>
          )}
        </Motion.section>
      </div>
    </Motion.main>
  )
}

export default LoginPage
