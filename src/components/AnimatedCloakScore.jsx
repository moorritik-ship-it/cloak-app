import { animate } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

/**
 * @param {{ value: number }} props
 */
export default function AnimatedCloakScore({ value }) {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef(value)

  useEffect(() => {
    const from = prevRef.current
    prevRef.current = value
    if (from === value) return undefined
    const ctrl = animate(from, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    })
    return () => ctrl.stop()
  }, [value])

  return <span className="dash-cloak-value dash-cloak-value--animated">{display}</span>
}
