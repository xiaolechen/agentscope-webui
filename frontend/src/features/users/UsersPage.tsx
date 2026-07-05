import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import UsersTab from './UsersTab'
import TenantsTab from './TenantsTab'
import TenantViewTab from './TenantViewTab'

// The platform/system tenant id. Members of this tenant are platform operators
// who can create and configure other tenants (see require_platform_access).
const PLATFORM_TENANT_ID = 'agentscope'

type Tab = 'users' | 'tenants' | 'tenant'

/** User management shell. Platform operators (members of the 'agentscope'
 *  tenant) get a "Tenants" tab to create/configure tenants; regular tenant
 *  admins get a read-only "My Tenant" tab to view their assigned resources.
 *  Everyone with the 'users' permission gets the "Users" tab. */
export default function UsersPage() {
  const { t } = useTranslation()
  const memberships = useAuthStore(s => s.memberships)
  const role = useAuthStore(s => s.role)
  const [tab, setTab] = useState<Tab>('users')

  const isPlatformUser = memberships.some(m => m.tenant_id === PLATFORM_TENANT_ID)
  // Regular tenant_admins (not platform operators) get a read-only tenant view.
  const isRegularTenantAdmin = !isPlatformUser && role === 'tenant_admin'

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
