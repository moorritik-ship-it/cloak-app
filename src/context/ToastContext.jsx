import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion as Motion } from 'framer-motion'
import { ToastContext } from './toastContextCore.js'

let idSeq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (message, variant = 'default') => {
      const id = ++idSeq
      setToasts((prev) => [...prev, { id, message, variant }])
      window.setTimeout(() => dismiss(id), 3000)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => (
            <Motion.div
              key={t.id}
              className={`toast-item toast-item--${t.variant}`}
              role="status"
              initial={{ opacity: 0, x: 80, y: -12, scale: 0.92 }}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', damping: 22, stiffness: 380 }}
              layout
            >
              {t.message}
            </Motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
