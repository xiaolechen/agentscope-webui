import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import UsersTab from './UsersTab'
import TenantsTab from './TenantsTab'
import TenantViewTab from './TenantViewTab'

type Tab = 'users' | 'tenants' | 'tenant'

/** User management shell. Platform admins (role='admin') get a "Tenants" tab
 *  to create/configure tenants; tenant_admins get a read-only "My Tenant" tab
 *  to view their assigned resources. Everyone with the 'users' permission gets
 *  the "Users" tab. */
export default function UsersPage() {
  const { t } = useTranslation()
  const role = useAuthStore(s => s.role)
  const [tab, setTab] = useState<Tab>('users')

  // Base tab visibility on the active role, not membership, so an admin who
  // has dropped into a regular tenant (role becomes tenant_admin) sees the
  // tenant_admin view, not the platform Tenants tab.
  const isPlatformUser = role === 'admin'
  const isRegularTenantAdmin = role === 'tenant_admin'

  const tabs: { key: Tab; label: string }[] = [
    { key: 'users', label: t('users.tab.users') },
    // Platform operators manage tenants; regular tenant admins view their own.
    ...(isPlatformUser ? [{ key: 'tenants' as Tab, label: t('users.tab.tenants') }] : []),
    ...(isRegularTenantAdmin ? [{ key: 'tenant' as Tab, label: t('users.tab.tenant') }] : []),
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center gap-1 shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        {tabs.map(tb => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className="as-btn as-btn-ghost as-btn-sm"
            style={tab === tb.key
              ? { color: 'var(--as-primary)', fontWeight: 600 }
              : { color: 'var(--as-ink-48)' }}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'users' ? <UsersTab />
          : tab === 'tenants' ? <TenantsTab />
          : <TenantViewTab />}
      </div>
    </div>
  )
}
