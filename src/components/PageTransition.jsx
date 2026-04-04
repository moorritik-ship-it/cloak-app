import { motion as Motion } from 'framer-motion'

function PageTransition({ children }) {
  return (
    <Motion.div
      className="page-transition w-full min-w-0 max-w-[100vw] flex-1 overflow-x-hidden"
      initial={{ opacity: 0, y: 18, x: 14 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      exit={{ opacity: 0, y: -14, x: -12 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Motion.div>
  )
}

export default PageTransition
