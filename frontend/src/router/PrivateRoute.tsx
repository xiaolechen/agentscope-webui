import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'

interface Props {
  adminOnly?: boolean
}

export default function PrivateRoute({ adminOnly = false }: Props) {
  const token = useAuthStore(s => s.token)
  const role = useAuthStore(s => s.role)
  if (!token) return <Navigate to="/login" replace />
  if (adminOnly && role !== 'admin') return <Navigate to="/chat" replace />
  return <Outlet />
}
