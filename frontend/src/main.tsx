import React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './router/routes'
import './i18n/config'
import './index.css'

// Capture unhandled Promise rejections that escape all .catch() handlers
// (e.g. async functions inside useEffect that throw without a try/catch).
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandledrejection]', event.reason)
})

// Exported so login/logout flows can clear stale cache when switching accounts.
// Without this, a new login inherits the previous user's cached query results
// (user lists, agents, etc.) until each query refetches — visible as a flash
// of the prior user's data.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: {
      onError: (error: unknown) => {
        const err = error as any
        const detail = err?.response?.data?.detail ?? err?.message ?? String(error)
        console.error('[mutation error]', detail, error)
      },
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
)
