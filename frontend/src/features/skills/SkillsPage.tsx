import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webuiApi } from '@/api/webui'
import { Search } from 'lucide-react'

const PAGE = 10

export default function SkillsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const { data: skills = [], isLoading } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })

  const toggleMut = useMutation({
    mutationFn: ({ path, is_enabled }: { path: string; is_enabled: boolean }) =>
      webuiApi.toggleSkill(path, is_enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-lib'] }),
  })

  const filtered = (skills as any[]).filter((s: any) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.path.toLowerCase().includes(search.toLowerCase())
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const paged = filtered.slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('skills.title')}</h2>
        <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('skills.hint.pathManagement')}</span>
      </div>

      <div className="px-6 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--as-hairline)' }}>
        <Search size={14} style={{ color: 'var(--as-ink-48)' }} />
        <input
          placeholder={t('skills.search.placeholder')}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          className="flex-1 outline-none text-sm bg-transparent"
          style={{ color: 'var(--as-ink)' }}
        />
        <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('skills.search.count', { count: filtered.length })}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}

        {paged.map((s: any) => (
          <div key={s.path} className="flex items-center gap-3 p-3 rounded-[var(--as-r-md)] bg-white transition-opacity"
            style={{ border: '1px solid var(--as-hairline)', opacity: s.is_enabled ? 1 : 0.55 }}>
            <button
              onClick={() => toggleMut.mutate({ path: s.path, is_enabled: !s.is_enabled })}
              disabled={toggleMut.isPending}
              className="shrink-0 px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors disabled:opacity-50"
              style={s.is_enabled
                ? { background: 'var(--as-primary)', color: '#fff' }
                : { background: 'var(--as-hairline)', color: 'var(--as-ink-48)' }}>
              {s.is_enabled ? t('skills.badge.enabled') : t('skills.badge.disabled')}
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate"
                style={{ color: s.is_enabled ? 'var(--as-ink)' : 'var(--as-ink-48)' }}>
                {s.name}
              </p>
              <p className="text-xs truncate font-mono mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{s.path}</p>
            </div>
          </div>
        ))}

        {!isLoading && !paged.length && (
          <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>
            {!(skills as any[]).length
              ? t('skills.empty.noSkills')
              : t('skills.empty.noMatch')}
          </p>
        )}

        {filtered.length > PAGE && (
          <div className="flex items-center gap-3 pt-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="text-xs px-2 py-1 border rounded disabled:opacity-40"
              style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
            <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="text-xs px-2 py-1 border rounded disabled:opacity-40"
              style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
