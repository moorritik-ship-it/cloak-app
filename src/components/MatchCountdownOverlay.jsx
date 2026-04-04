import { AnimatePresence, motion as Motion } from 'framer-motion'

/**
 * @param {{ digit: number | null }} props
 */
export default function MatchCountdownOverlay({ digit }) {
  return (
    <div className="vc-match-countdown-layer" aria-hidden>
      <AnimatePresence mode="wait">
        {digit != null && digit > 0 ? (
          <Motion.div
            key={digit}
            className="vc-match-countdown-digit"
            initial={{ opacity: 0, scale: 0.35 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.35, transition: { duration: 0.12 } }}
            transition={{
              type: 'spring',
              stiffness: 520,
              damping: 18,
              mass: 0.55,
            }}
          >
            {digit}
          </Motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
