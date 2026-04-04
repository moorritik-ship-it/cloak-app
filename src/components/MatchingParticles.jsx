import { useMemo } from 'react'
import { motion as Motion } from 'framer-motion'

const NODE_COORDS = [
  { x: 12, y: 22 },
  { x: 88, y: 18 },
  { x: 52, y: 12 },
  { x: 28, y: 68 },
  { x: 74, y: 62 },
  { x: 92, y: 82 },
  { x: 14, y: 86 },
  { x: 48, y: 48 },
  { x: 68, y: 36 },
  { x: 36, y: 40 },
]

const EDGES = [
  [0, 1],
  [0, 3],
  [1, 2],
  [1, 8],
  [2, 8],
  [3, 7],
  [3, 6],
  [4, 5],
  [4, 8],
  [5, 8],
  [6, 7],
  [7, 9],
  [8, 9],
  [2, 9],
]

/** Omegle-style network: drifting nodes, pulsing edges, morphing center blob — loops forever. */
export default function MatchingParticles() {
  const nodes = useMemo(
    () =>
      NODE_COORDS.map((c, i) => ({
        ...c,
        id: i,
        dur: 7 + (i % 5) * 0.9,
        delay: i * 0.22,
      })),
    [],
  )

  return (
    <div className="vc-match-particles vc-match-particles--network" aria-hidden>
      <div className="vc-match-morph-wrap">
        <Motion.div
          className="vc-match-morph-blob"
          animate={{
            borderRadius: [
              '50%',
              '42% 58% 62% 38% / 48% 52% 48% 52%',
              '58% 42% 38% 62% / 52% 48% 52% 48%',
              '45% 55% 55% 45% / 55% 45% 55% 45%',
              '50%',
            ],
            scale: [1, 1.08, 0.96, 1.04, 1],
            rotate: [0, 45, -30, 20, 0],
          }}
          transition={{
            duration: 14,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      </div>

      <svg className="vc-match-network-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="vc-net-line" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-purple)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.45" />
          </linearGradient>
          <linearGradient id="vc-net-node" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-purple)" />
            <stop offset="100%" stopColor="var(--accent-cyan)" />
          </linearGradient>
        </defs>

        {EDGES.map(([a, b], i) => {
          const p = NODE_COORDS[a]
          const q = NODE_COORDS[b]
          return (
            <Motion.line
              key={`${a}-${b}-${i}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke="url(#vc-net-line)"
              strokeWidth={0.35}
              strokeLinecap="round"
              animate={{
                opacity: [0.12, 0.5, 0.18],
                strokeWidth: [0.28, 0.55, 0.32],
              }}
              transition={{
                duration: 4 + (i % 4) * 0.5,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.08,
              }}
            />
          )
        })}

        {nodes.map((n) => (
          <Motion.circle
            key={n.id}
            r={1.1 + (n.id % 3) * 0.35}
            fill="url(#vc-net-node)"
            animate={{
              cx: [n.x - 2.2, n.x + 2.5, n.x - 1, n.x + 1.8, n.x],
              cy: [n.y, n.y + 2.8, n.y - 2.2, n.y + 1.2, n.y],
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
