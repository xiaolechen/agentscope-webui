import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import LangSwitcher from '@/components/LangSwitcher'
import {
  MessageSquare, Clock, Bot, Wand2, Network, Key,
  Calendar, FileText, Settings, Users, LogOut,
} from 'lucide-react'

const NAV = [
  { to: '/chat',         labelKey: 'nav.chat',        Icon: MessageSquare },
  { to: '/sessions',    labelKey: 'nav.sessions',    Icon: Clock },
  { to: '/agents',      labelKey: 'nav.agents',      Icon: Bot,      adminOnly: true },
  { to: '/skills',      labelKey: 'nav.skills',      Icon: Wand2,    adminOnly: true },
  { to: '/mcp',         labelKey: 'nav.mcp',         Icon: Network,  adminOnly: true },
  { to: '/credentials', labelKey: 'nav.credentials', Icon: Key,      adminOnly: true },
  { to: '/schedules',   labelKey: 'nav.schedules',   Icon: Calendar, adminOnly: true },
  { to: '/logs',        labelKey: 'nav.logs',        Icon: FileText, adminOnly: true },
  { to: '/settings',    labelKey: 'nav.settings',    Icon: Settings, adminOnly: true },
  { to: '/users',       labelKey: 'nav.users',       Icon: Users,    adminOnly: true },
] as const

export default function AppLayout() {
  const { t } = useTranslation()
  const role = useAuthStore(s => s.role)
  const username = useAuthStore(s => s.username)
  const logout = useAuthStore(s => s.logout)
  const navigate = useNavigate()

  const visibleNav = NAV.filter(item => !(item as any).adminOnly || role === 'admin')

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--as-canvas)' }}>
      <aside className="w-52 flex flex-col shrink-0 border-r" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
        <div className="px-4 border-b flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)' }}>
          <span className="as-heading" style={{ display: 'block' }}>{t('brand.name')}</span>
          <LangSwitcher />
        </div>

        <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map(({ to, labelKey, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `as-nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={14} />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 border-t flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)' }}>
          <span className="flex-1 as-caption truncate" style={{ color: 'var(--as-ink-80)' }}>{username}</span>
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
