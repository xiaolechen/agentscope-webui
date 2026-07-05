import React, { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import PrivateRoute from './PrivateRoute'
import AppLayout from '@/layouts/AppLayout'
import LoginPage from '@/features/auth/LoginPage'
import ErrorBoundary from '@/components/ErrorBoundary'

const Chat        = lazy(() => import('@/features/chat/ChatPage'))
const Sessions    = lazy(() => import('@/features/sessions/SessionsPage'))
const Knowledge   = lazy(() => import('@/features/knowledge/KnowledgePage'))
const KnowledgeDetail = lazy(() => import('@/features/knowledge/KnowledgeDetailPage'))
const Agents      = lazy(() => import('@/features/agents/AgentsPage'))
const Skills      = lazy(() => import('@/features/skills/SkillsPage'))
const Mcp         = lazy(() => import('@/features/mcp/McpPage'))
const Credentials = lazy(() => import('@/features/credentials/CredentialsPage'))
const Schedules   = lazy(() => import('@/features/schedules/SchedulesPage'))
const Logs        = lazy(() => import('@/features/logs/LogsPage'))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'))
const Users       = lazy(() => import('@/features/users/UsersPage'))

const Fallback = () => (
  <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--as-ink-48)' }}>
    Loading…
  </div>
)

const wrap = (C: React.LazyExoticComponent<() => React.JSX.Element>) => (
  <ErrorBoundary>
    <Suspense fallback={<Fallback />}><C /></Suspense>
  </ErrorBoundary>
)

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <PrivateRoute />,
    children: [{
      element: <AppLayout />,
      children: [
        { path: '/', element: <Navigate to="/chat" replace /> },
        { path: '/chat',     element: wrap(Chat) },
        { path: '/sessions', element: wrap(Sessions) },
        { path: '/knowledge',     element: wrap(Knowledge) },
        { path: '/knowledge/:name', element: wrap(KnowledgeDetail) },
        { path: '/schedules', element: wrap(Schedules) },
        {
          // Configuration group — tenant-delegatable via menu permission.
          element: <PrivateRoute requiredPermission="agents" />,
          children: [{ path: '/agents', element: wrap(Agents) }],
        },
        {
          element: <PrivateRoute requiredPermission="skills" />,
          children: [{ path: '/skills', element: wrap(Skills) }],
        },
        {
          element: <PrivateRoute requiredPermission="mcp" />,
          children: [{ path: '/mcp', element: wrap(Mcp) }],
        },
        {
          element: <PrivateRoute requiredPermission="users" />,
          children: [{ path: '/users', element: wrap(Users) }],
        },
        {
          // System group — super-admin only. logs/settings manage cross-tenant
          // infrastructure and credentials are global; these need data-scoping
          // before they can be safely delegated to tenants.
          element: <PrivateRoute adminOnly />,
          children: [
            { path: '/credentials', element: wrap(Credentials) },
            { path: '/logs',        element: wrap(Logs) },
            { path: '/settings',    element: wrap(SettingsPage) },
          ],
        },
      ],
    }],
  },
])
