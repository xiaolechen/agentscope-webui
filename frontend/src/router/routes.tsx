import React, { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import PrivateRoute from './PrivateRoute'
import AppLayout from '@/layouts/AppLayout'
import LoginPage from '@/features/auth/LoginPage'
import ErrorBoundary from '@/components/ErrorBoundary'

const Chat        = lazy(() => import('@/features/chat/ChatPage'))
const Sessions    = lazy(() => import('@/features/sessions/SessionsPage'))
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
        {
          element: <PrivateRoute adminOnly />,
          children: [
            { path: '/agents',      element: wrap(Agents) },
            { path: '/skills',      element: wrap(Skills) },
            { path: '/mcp',         element: wrap(Mcp) },
            { path: '/credentials', element: wrap(Credentials) },
            { path: '/schedules',   element: wrap(Schedules) },
            { path: '/logs',        element: wrap(Logs) },
            { path: '/settings',    element: wrap(SettingsPage) },
            { path: '/users',       element: wrap(Users) },
          ],
        },
      ],
    }],
  },
])
