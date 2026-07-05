import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Users as UsersIcon, Shield, Server, Wrench, Bot } from 'lucide-react'
import { tenantsApi } from '@/api/tenants'
import { agentsApi } from '@/api/agents'
import { credentialsApi } from '@/api/credentials'
import { webuiApi, type McpDef, type SkillDef } from '@/api/webui'

// `as const` so the values form a literal union — t() accepts them without a
// defaultValue, and TS verifies every MenuPermission maps to a real nav key.
const MENU_LABEL_KEY = {
  chat: 'nav.chat', sessions: 'nav.sessions', knowledge: 'nav.knowledge', schedules: 'nav.schedules',
  agents: 'nav.agents', skills: 'nav.skills', mcp: 'nav.mcp',
  credentials: 'nav.credentials', logs: 'nav.logs', settings: 'nav.settings', users: 'nav.users',
} as const

/** Read-only view of the caller's active tenant: menu permissions granted by
 *  the platform operator and the assigned resource pool (agents/mcps/skills/
 *  credentials). Shown to regular tenant_admins who cannot edit the tenant
 *  configuration themselves. */
export default function TenantViewTab() {
  const { t } = useTranslation()
  const { data: tenant } = useQuery({ queryKey: ['my-tenant'], queryFn: tenantsApi.getMyTenant })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const { data: mcps = [] } = useQuery({ queryKey: ['mcp-lib'], queryFn: webuiApi.getMcpLib })
  const { data: skills = [] } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })
  const { data: credentials = [] } = useQuery({ queryKey: ['credentials'], queryFn: credentialsApi.list })

  if (!tenant) return null

  const perms = tenant.menu_permissions

  const cardCls = 'as-card p-4'
  const titleCls = 'text-xs font-semibold uppercase tracking-wide'
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>
          {tenant.display_name}
        </h2>
        <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--as-parchment)', color: 'var(--as-ink-80)', border: '1px solid var(--as-hairline)' }}>
          {tenant.name}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Summary */}
        <div className="as-card p-4 flex items-center gap-3">
          <UsersIcon size={18} style={{ color: 'var(--as-ink-48)' }} />
          <span className="text-sm" style={{ color: 'var(--as-ink-80)' }}>
            {t('tenants.card.members', { count: tenant.member_count ?? 0 })}
          </span>
          <span className="text-sm ml-4" style={{ color: 'var(--as-ink-80)' }}>
            {t('tenants.card.menus', { count: perms.length })}
          </span>
        </div>

        {/* Menu permissions */}
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-3">
            <Shield size={14} style={{ color: 'var(--as-primary)' }} />
            <p className={titleCls} style={{ color: 'var(--as-ink-80)' }}>{t('tenants.detail.tab.perms')}</p>
          </div>
          {perms.length ? (
            <div className="flex flex-wrap gap-2">
              {perms.map(p => (
                <span key={p} className="text-xs px-2.5 py-1.5 rounded-[var(--as-pill)]"
                  style={{ background: 'var(--as-primary)', color: '#fff' }}>
                  {t(MENU_LABEL_KEY[p])}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('common.empty.noDataHint')}</p>
          )}
        </div>

        {/* Assigned resources */}
        <div className={cardCls}>
          <p className={`${titleCls} mb-3`} style={{ color: 'var(--as-ink-80)' }}>
            {t('tenants.detail.tab.resources')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ResourceColumn
              icon={<Bot size={14} style={{ color: 'var(--as-primary)' }} />}
              title={t('tenants.detail.resources.agents')}
              emptyHint={t('tenants.detail.resources.emptyAgents')}
              ids={tenant.assigned_agents}
              render={id => agents.find(a => a.id === id)?.data.name ?? id.slice(0, 8)}
            />
            <ResourceColumn
              icon={<Server size={14} style={{ color: 'var(--as-primary)' }} />}
              title={t('tenants.detail.resources.mcps')}
              emptyHint={t('tenants.detail.resources.emptyMcps')}
              ids={tenant.assigned_mcps}
              render={id => mcps.find((m: McpDef) => m.name === id)?.name ?? id}
            />
            <ResourceColumn
              icon={<Wrench size={14} style={{ color: 'var(--as-primary)' }} />}
              title={t('tenants.detail.resources.skills')}
              emptyHint={t('tenants.detail.resources.emptySkills')}
              ids={tenant.assigned_skills}
              render={id => skills.find((s: SkillDef) => s.path === id)?.name ?? id}
            />
            <ResourceColumn
              icon={<Shield size={14} style={{ color: 'var(--as-primary)' }} />}
              title={t('tenants.detail.resources.credentials')}
              emptyHint={t('tenants.detail.resources.emptyCredentials')}
              ids={tenant.assigned_credentials}
              render={id => (credentials.find(c => c.id === id)?.data.name as string | undefined) ?? id.slice(0, 8)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ResourceColumn({ icon, title, emptyHint, ids, render }: {
  icon: React.ReactNode
  title: string
  emptyHint: string
  ids: string[]
  render: (id: string) => string
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <p className="text-xs font-semibold" style={{ color: 'var(--as-ink-80)' }}>{title}</p>
        <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{ids.length}</span>
      </div>
      <div className="space-y-1 max-h-40 overflow-y-auto rounded-[var(--as-r-sm)] p-2"
        style={{ border: '1px solid var(--as-hairline)' }}>
        {ids.map(id => (
          <p key={id} className="text-xs truncate" style={{ color: 'var(--as-ink-80)' }}>{render(id)}</p>
        ))}
        {!ids.length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{emptyHint}</p>}
      </div>
    </div>
  )
}
