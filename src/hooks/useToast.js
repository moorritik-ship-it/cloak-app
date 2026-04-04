import { useContext } from 'react'
import { ToastContext } from '../context/toastContextCore.js'

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) return { showToast: () => {} }
  return ctx
}
