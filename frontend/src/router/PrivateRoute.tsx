import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore, type MenuPermission } from '@/store/auth'

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
  /** Legacy: restrict to super-admin only (system-level routes). */
  adminOnly?: boolean
  /** New: require a menu permission (tenant-scoped). Admin always passes. */
  requiredPermission?: MenuPermission
}

export default function PrivateRoute({ adminOnly = false, requiredPermission }: Props) {
  const token = useAuthStore(s => s.token)
  const role = useAuthStore(s => s.role)
  const hasMenu = useAuthStore(s => s.hasMenu)
  const logout = useAuthStore(s => s.logout)

  if (!token || isTokenExpired(token)) {
    // Clear stale token from store so downstream components don't see it
    if (token) logout()
    return <Navigate to="/login" replace />
  }
  // Super-admin-only routes (e.g. tenant management, logs, settings, users).
  if (adminOnly && role !== 'admin') return <Navigate to="/chat" replace />
  // Permission-gated routes: admin passes; tenant members need the perm.
  if (requiredPermission && !hasMenu(requiredPermission)) {
    return <Navigate to="/chat" replace />
  }
  return <Outlet />
}
