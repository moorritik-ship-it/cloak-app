import { useMemo } from 'react'
import { motion as Motion } from 'framer-motion'

const NODES = [
  { x: 10, y: 18 },
  { x: 88, y: 22 },
  { x: 48, y: 12 },
  { x: 22, y: 72 },
  { x: 78, y: 68 },
  { x: 92, y: 88 },
  { x: 14, y: 88 },
  { x: 52, y: 48 },
]

const EDGES = [
  [0, 1],
  [0, 3],
  [1, 2],
  [2, 7],
  [3, 6],
  [3, 7],
  [4, 5],
  [4, 7],
  [5, 7],
  [6, 7],
]

/** Slow floating network behind the login card */
export default function LoginParticles() {
  const nodes = useMemo(
    () =>
      NODES.map((c, i) => ({
        ...c,
        id: i,
        dur: 14 + (i % 4) * 2.2,
        delay: i * 0.35,
      })),
    [],
  )

  return (
    <div className="login-particles-layer" aria-hidden>
      <svg className="login-particles-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="login-net-line" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-purple)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.18" />
          </linearGradient>
          <linearGradient id="login-net-node" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-purple)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.75" />
          </linearGradient>
        </defs>

        {EDGES.map(([a, b], i) => {
          const p = NODES[a]
          const q = NODES[b]
          return (
            <Motion.line
              key={`${a}-${b}-${i}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke="url(#login-net-line)"
              strokeWidth={0.22}
              strokeLinecap="round"
              animate={{
                opacity: [0.08, 0.28, 0.1],
              }}
              transition={{
                duration: 6 + (i % 3) * 1.2,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.15,
              }}
            />
          )
        })}

        {nodes.map((n) => (
          <Motion.circle
            key={n.id}
            r={0.55 + (n.id % 3) * 0.2}
            fill="url(#login-net-node)"
            animate={{
              cx: [n.x - 1.2, n.x + 1.4, n.x - 0.6, n.x + 0.9, n.x],
              cy: [n.y, n.y + 1.6, n.y - 1.1, n.y + 0.7, n.y],
            }}
            transition={{
              duration: n.dur,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: n.delay,
            }}
          />
        ))}
      </svg>
    </div>
  )
}
