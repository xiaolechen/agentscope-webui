import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'

/** Decode JWT `exp` claim client-side (no signature check) to detect expiry. */
function isTokenExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1]
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof decoded.exp === 'number' && decoded.exp * 1000 < Date.now()
  } catch {
    return true
  }
}

interface Props {
  adminOnly?: boolean
}

export default function PrivateRoute({ adminOnly = false }: Props) {
  const token = useAuthStore(s => s.token)
  const role = useAuthStore(s => s.role)
  const logout = useAuthStore(s => s.logout)

  if (!token || isTokenExpired(token)) {
    // Clear stale token from store so downstream components don't see it
    if (token) logout()
    return <Navigate to="/login" replace />
  }
  if (adminOnly && role !== 'admin') return <Navigate to="/chat" replace />
  return <Outlet />
}
