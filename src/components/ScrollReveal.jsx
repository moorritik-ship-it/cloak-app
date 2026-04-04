import { useRef } from 'react'
import { motion as Motion, useInView } from 'framer-motion'

/**
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @param {string} [props.className]
 */
export default function ScrollReveal({ children, className = '' }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })

  return (
    <Motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 36 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 36 }}
      transition={{
        type: 'spring',
        damping: 22,
        stiffness: 200,
        mass: 0.9,
      }}
    >
      {children}
    </Motion.div>
  )
}
