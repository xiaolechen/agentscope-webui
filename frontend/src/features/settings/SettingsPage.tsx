import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { webuiApi } from '@/api/webui'
import { Trash2, RotateCcw } from 'lucide-react'
import RedisBrowser from './RedisBrowser'

const THEMES = ['system', 'light', 'dark'] as const
type Tab = 'settings' | 'redis'

export default function SettingsPage() {
  const { t } = useTranslation()
  const username = useAuthStore(s => s.username)
  const role = useAuthStore(s => s.role)
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('settings')
  const [theme, setTheme] = useState(localStorage.getItem('theme') ?? 'system')
  const [newPath, setNewPath] = useState('')
  const [restartMsg, setRestartMsg] = useState<string | null>(null)

  const saveTheme = (t: string) => {
    setTheme(t)
    localStorage.setItem('theme', t)
    document.documentElement.classList.remove('light', 'dark')
    if (t !== 'system') document.documentElement.classList.add(t)
  }

  const { data: skills = [] } = useQuery({
    queryKey: ['skill-lib'],
    queryFn: webuiApi.getSkillLib,
    enabled: role === 'admin',
  })

  const { data: skillDirs = [] } = useQuery({
    queryKey: ['skill-dirs'],
    queryFn: webuiApi.getSkillDirs,
    enabled: role === 'admin',
  })

  const addDirMut = useMutation({
    mutationFn: (path: string) => webuiApi.addSkillDir(path),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['skill-dirs'] }); qc.invalidateQueries({ queryKey: ['skill-lib'] }); setNewPath('') },
  })

  const deleteDirMut = useMutation({
    mutationFn: (path: string) => webuiApi.deleteSkillDir(path),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['skill-dirs'] }); qc.invalidateQueries({ queryKey: ['skill-lib'] }) },
  })

  const restartMut = useMutation({
    mutationFn: webuiApi.restart,
    onSuccess: () => {
      setRestartMsg(t('settings.backend.restarting'))
      // Poll until backend is back up
      const start = Date.now()
      const poll = setInterval(async () => {
        if (Date.now() - start > 30000) {
          clearInterval(poll)
          setRestartMsg(t('settings.backend.restartTimeout'))
          return
        }
        try {
          await fetch('/api/auth/me', { method: 'GET' })
          clearInterval(poll)
          setRestartMsg(t('settings.backend.restartComplete'))
          setTimeout(() => setRestartMsg(null), 3000)
        } catch {}
      }, 1000)
    },
    onError: () => setRestartMsg(t('settings.backend.restartFailed')),
  })

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--as-ink-80)' }}>{title}</h3>
      <div className="bg-white rounded-[var(--as-r-md)] p-4" style={{ border: '1px solid var(--as-hairline)' }}>{children}</div>
    </section>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--as-ink)' }}>{t('settings.title')}</h2>
        <div className="ml-6 flex items-center gap-1">
          <button
            onClick={() => setTab('settings')}
            className="px-3 py-1 text-sm rounded-[var(--as-r-sm)] transition-colors"
            style={{
              background: tab === 'settings' ? 'var(--as-primary)' : 'transparent',
              color: tab === 'settings' ? '#fff' : 'var(--as-ink-80)',
            }}
          >
            {t('settings.tab.settings')}
          </button>
          {role === 'admin' && (
            <button
              onClick={() => setTab('redis')}
              className="px-3 py-1 text-sm rounded-[var(--as-r-sm)] transition-colors"
              style={{
                background: tab === 'redis' ? 'var(--as-primary)' : 'transparent',
                color: tab === 'redis' ? '#fff' : 'var(--as-ink-80)',
              }}
            >
              {t('settings.tab.redis')}
            </button>
          )}
        </div>
      </div>

      {tab === 'redis' && role === 'admin' ? (
        <RedisBrowser />
      ) : (
      <div className="p-6 max-w-lg space-y-8 overflow-y-auto">
        <Section title={t('settings.section.account')}>
          <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>
            {t('settings.account.signedInAs')} <span className="font-medium" style={{ color: 'var(--as-ink)' }}>{username}</span>
          </p>
        </Section>

        <Section title={t('settings.section.appearance')}>
          <div className="flex rounded-[var(--as-r-sm)] overflow-hidden w-fit" style={{ border: '1px solid var(--as-hairline)' }}>
            {THEMES.map(t => (
              <button key={t} onClick={() => saveTheme(t)}
                className="px-4 py-1.5 text-sm capitalize transition-colors"
                style={{ background: theme === t ? 'var(--as-primary)' : 'transparent', color: theme === t ? '#fff' : 'var(--as-ink-80)' }}>
                {t}
              </button>
            ))}
          </div>
        </Section>

        {role === 'admin' && (
          <Section title={t('settings.section.skillPaths')}>
            <p className="text-xs mb-3" style={{ color: 'var(--as-ink-48)' }}>
              {t('settings.skillPaths.help')}
            </p>
            <div className="space-y-1.5 mb-3">
              {(skillDirs as string[]).map((dir: string) => (
                <div key={dir} className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--as-r-sm)]"
                  style={{ background: 'var(--as-parchment)' }}>
                  <p className="flex-1 text-xs font-mono truncate" style={{ color: 'var(--as-ink)' }}>{dir}</p>
                  <button onClick={() => deleteDirMut.mutate(dir)}
                    className="p-0.5 shrink-0" style={{ color: '#ef4444' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!(skillDirs as string[]).length && (
                <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('settings.skillPaths.empty')}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newPath}
                onChange={e => setNewPath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && newPath.trim() && addDirMut.mutate(newPath.trim())}
                placeholder={t('settings.skillPaths.placeholder')}
                autoComplete="off"
                className="as-input flex-1 text-xs font-mono"
              />
              <button
                onClick={() => newPath.trim() && addDirMut.mutate(newPath.trim())}
                disabled={!newPath.trim() || addDirMut.isPending}
                className="as-btn as-btn-primary as-btn-sm">
                {t('common.button.add')}
              </button>
            </div>
            {(skillDirs as string[]).length > 0 && (
              <p className="text-xs mt-2" style={{ color: 'var(--as-ink-48)' }}>
                {t('settings.skillPaths.discovered', { count: skills.length })}
              </p>
            )}
          </Section>
        )}

        {role === 'admin' && (
          <Section title={t('settings.section.backend')}>
            <p className="text-xs mb-3" style={{ color: 'var(--as-ink-48)' }}>
              {t('settings.backend.restartHelp')}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setRestartMsg(null); restartMut.mutate() }}
                disabled={restartMut.isPending || !!restartMsg}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[var(--as-r-sm)] border transition-colors disabled:opacity-40"
                style={{ borderColor: 'var(--as-hairline)', color: 'var(--as-ink-80)' }}>
                <RotateCcw size={13} className={restartMut.isPending ? 'animate-spin' : ''} />
                {t('settings.backend.restart')}
              </button>
              {restartMsg && (
                <span className="text-xs" style={{ color: restartMsg.includes('✓') ? '#16a34a' : 'var(--as-ink-48)' }}>
                  {restartMsg}
                </span>
              )}
            </div>
          </Section>
        )}
      </div>
      )}
    </div>
  )
}
