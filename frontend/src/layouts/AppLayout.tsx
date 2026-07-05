import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useAuthStore, type MenuPermission } from '@/store/auth'
import LangSwitcher from '@/components/LangSwitcher'
import {
  MessageSquare, Clock, Bot, Wand2, Network, Key,
  Calendar, FileText, Settings, Users, LogOut, BookOpen, ChevronDown,
} from 'lucide-react'

// Persist per-group collapse state across reloads. Default: all expanded
// (a group key absent from the record → not collapsed).
const COLLAPSE_KEY = 'webui.nav.collapsed'

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// Literal unions so t() accepts these keys without a defaultValue and TS
// verifies they exist in the locale resources.
type NavGroupKey = 'nav.groups.workspace' | 'nav.groups.configuration' | 'nav.groups.system'
type NavKey =
  | 'nav.chat' | 'nav.sessions' | 'nav.knowledge' | 'nav.schedules'
  | 'nav.agents' | 'nav.skills' | 'nav.mcp'
  | 'nav.credentials' | 'nav.logs' | 'nav.settings' | 'nav.users'

interface NavItem {
  to: string
  labelKey: NavKey
  Icon: typeof MessageSquare
  requiredPermission: MenuPermission
}

const NAV_GROUPS: { labelKey: NavGroupKey; items: NavItem[] }[] = [
  {
    labelKey: 'nav.groups.workspace',
    items: [
      { to: '/chat',       labelKey: 'nav.chat',       Icon: MessageSquare, requiredPermission: 'chat' },
      { to: '/sessions',   labelKey: 'nav.sessions',   Icon: Clock,         requiredPermission: 'sessions' },
      { to: '/knowledge',  labelKey: 'nav.knowledge',  Icon: BookOpen,      requiredPermission: 'knowledge' },
      { to: '/schedules',  labelKey: 'nav.schedules',  Icon: Calendar,      requiredPermission: 'schedules' },
    ],
  },
  {
    labelKey: 'nav.groups.configuration',
    items: [
      { to: '/agents',      labelKey: 'nav.agents',      Icon: Bot,      requiredPermission: 'agents' },
      { to: '/skills',      labelKey: 'nav.skills',      Icon: Wand2,    requiredPermission: 'skills' },
      { to: '/mcp',         labelKey: 'nav.mcp',         Icon: Network,  requiredPermission: 'mcp' },
    ],
  },
  {
    labelKey: 'nav.groups.system',
    items: [
      { to: '/credentials', labelKey: 'nav.credentials', Icon: Key,      requiredPermission: 'credentials' },
      { to: '/logs',        labelKey: 'nav.logs',        Icon: FileText, requiredPermission: 'logs' },
      { to: '/settings',    labelKey: 'nav.settings',    Icon: Settings, requiredPermission: 'settings' },
      { to: '/users',       labelKey: 'nav.users',       Icon: Users,    requiredPermission: 'users' },
    ],
  },
]

export default function AppLayout() {
  const { t } = useTranslation()
  const hasMenu = useAuthStore(s => s.hasMenu)
  const logout = useAuthStore(s => s.logout)
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)

  const toggleGroup = (key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--as-canvas)' }}>
      <aside className="w-52 flex flex-col shrink-0 border-r" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
        <div className="px-4 border-b flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)' }}>
          <span className="as-heading" style={{ display: 'block' }}>{t('brand.name')}</span>
          <LangSwitcher />
        </div>

        <nav className="flex-1 px-2 py-2 overflow-y-auto">
          {NAV_GROUPS.map(group => {
            const visibleItems = group.items.filter(item => hasMenu(item.requiredPermission))
            if (visibleItems.length === 0) return null
            const isCollapsed = !!collapsed[group.labelKey]
            return (
              <div key={group.labelKey} className="mb-3 last:mb-0">
                <button
                  type="button"
                  className="as-nav-section-header"
                  onClick={() => toggleGroup(group.labelKey)}
                  aria-expanded={!isCollapsed}
                >
                  <span>{t(group.labelKey)}</span>
                  <ChevronDown size={12} className={`as-nav-chevron${isCollapsed ? ' collapsed' : ''}`} />
                </button>
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {visibleItems.map(({ to, labelKey, Icon }) => (
                      <NavLink
                        key={to}
                        to={to}
                        className={({ isActive }) => `as-nav-item${isActive ? ' active' : ''}`}
                      >
                        <Icon size={14} />
                        {t(labelKey)}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <div className="px-3 border-t flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)' }}>
          <TenantSwitcher />
          <button
            onClick={() => { logout(); navigate('/login') }}
            className="as-btn as-btn-ghost"
            title={t('nav.signOut')}
            style={{ padding: '5px' }}
          >
            <LogOut size={13} />
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <Outlet />
      </main>
    </div>
  )
}

// ── Tenant switcher ──────────────────────────────────────────────────────────
// Bottom-left control. Shows the active tenant + role; click to switch to
// another membership. On switch, a fresh JWT is fetched and the page reloads
// so every cached query + route guard re-evaluates against the new tenant.

function TenantSwitcher() {
  const { t } = useTranslation()
  const username = useAuthStore(s => s.username)
  const tenantId = useAuthStore(s => s.tenantId)
  const memberships = useAuthStore(s => s.memberships)
  const role = useAuthStore(s => s.role)
  const switchTenant = useAuthStore(s => s.switchTenant)
  const [open, setOpen] = useState(false)

  // Only render the switcher when there's more than one membership. A single
  // tenant (or none) just shows the username, matching the old layout.
  if (memberships.length <= 1) {
    return <span className="flex-1 as-caption truncate" style={{ color: 'var(--as-ink-80)' }}>{username}</span>
  }

  const active = memberships.find(m => m.tenant_id === tenantId) ?? memberships[0]
  const onPick = async (tid: string) => {
    setOpen(false)
    if (tid === active.tenant_id) return
    try {
      await switchTenant(tid)
      // Force a full reload so route guards, cached queries, and lazy modules
      // all re-initialize against the new active tenant.
      window.location.assign('/chat')
    } catch {
      // switchTenant failure (e.g. 403 on a revoked membership) — keep the
      // user in their current tenant. The store is unchanged.
    }
  }

  return (
    <div className="flex-1 min-w-0 relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 as-caption truncate"
        style={{ color: 'var(--as-ink-80)' }}
        title={t('nav.switchTenant')}
      >
        <span className="truncate">{active.display_name}</span>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--as-ink-48)' }}>({role})</span>
        <ChevronDown size={11} style={{ marginLeft: 'auto', flexShrink: 0 }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full left-0 mb-1 z-50 rounded-[var(--as-r-sm)] py-1 shadow-lg"
            style={{ background: 'var(--as-canvas)', border: '1px solid var(--as-hairline)', minWidth: 160 }}
          >
            {memberships.map(m => (
              <button
                key={m.tenant_id}
                type="button"
                onClick={() => onPick(m.tenant_id)}
                className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--as-parchment)]"
                style={{
                  color: m.tenant_id === active.tenant_id ? 'var(--as-primary)' : 'var(--as-ink)',
                  fontWeight: m.tenant_id === active.tenant_id ? 600 : 400,
                }}
              >
                <span className="flex-1 truncate">{m.display_name}</span>
                <span className="text-[10px]" style={{ color: 'var(--as-ink-48)' }}>{m.role}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
